//! Native managed MCP proxy. Public ingress supplies a verified Agent JWT Run
//! identity; this module never forwards business decisions to Node.
#[cfg(test)]
mod fixtures;
mod http;
mod oauth;
mod security;
mod stdio;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rudder_d1_persistence::managed_mcp_runtime::{self as d1, Access, Error, Identity};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{collections::BTreeMap, path::PathBuf, time::Duration};

pub struct Host {
    pub deployment_mode: String,
    pub process_host: PathBuf,
    pub runtime_root: PathBuf,
    pub environment: BTreeMap<String, String>,
    pub oauth_redirect_uri: String,
}
pub struct Reply {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: Option<Value>,
}
const MODERN: &str = "2026-07-28";
const PROTOCOL: &str = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES: &str = "io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO: &str = "io.modelcontextprotocol/serverInfo";
const SUPPORTED: &[&str] = &[
    MODERN,
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
];
fn server_info() -> Value {
    json!({"name":"rudder-managed-mcp-proxy","version":"1.0.0"})
}
fn rpc(id: &Value, result: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":result})
}
fn rpc_error(id: &Value, code: i32, message: &str, data: Option<Value>) -> Value {
    let mut error = json!({"code":code,"message":message});
    if let Some(data) = data {
        error["data"] = data;
    }
    json!({"jsonrpc":"2.0","id":id,"error":error})
}
fn modern(mut result: Value, cache: bool, private: bool, info: bool) -> Value {
    result["resultType"] = json!("complete");
    if cache {
        result["ttlMs"] = json!(300000);
        result["cacheScope"] = json!(if private { "private" } else { "public" });
    }
    if info {
        if !result["_meta"].is_object() {
            result["_meta"] = json!({});
        }
        if result["_meta"].get(SERVER_INFO).is_none() {
            result["_meta"][SERVER_INFO] = server_info();
        }
    }
    result
}
fn response(status: u16, body: Option<Value>) -> Reply {
    Reply {
        status,
        headers: BTreeMap::new(),
        body,
    }
}

/// Same JSON-RPC envelope as routes/managed-mcp-runtime.ts. Authentication must
/// reject Board/API-key actors before calling this method: only signed Agent
/// JWTs containing organization, Agent and Run may construct `identity`.
pub async fn handle(
    pool: &PgPool,
    identity: &Identity,
    binding: &str,
    body: &Value,
    protocol_header: Option<&str>,
    host: &Host,
) -> Reply {
    if !body.is_object()
        || body["jsonrpc"] != "2.0"
        || !body["method"].is_string()
        || body
            .get("id")
            .is_some_and(|id| !id.is_null() && !id.is_string() && !id.is_number())
    {
        return response(
            400,
            Some(rpc_error(&Value::Null, -32600, "Invalid Request", None)),
        );
    }
    let id = body.get("id").unwrap_or(&Value::Null);
    let params = body
        .get("params")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let legacy = params["protocolVersion"]
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let revision = params["_meta"][PROTOCOL]
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let protocol = revision.or(legacy).or(protocol_header);
    let is_modern = protocol == Some(MODERN);
    if revision.zip(legacy).is_some_and(|(a, b)| a != b)
        || revision
            .or(legacy)
            .zip(protocol_header)
            .is_some_and(|(a, b)| a != b)
    {
        return response(
            200,
            Some(rpc_error(
                id,
                -32602,
                "Conflicting MCP protocol versions",
                None,
            )),
        );
    }
    let method = body["method"].as_str().unwrap();
    if is_modern
        && method != "server/discover"
        && (params["_meta"][PROTOCOL] != MODERN
            || !params["_meta"][CLIENT_CAPABILITIES].is_object())
    {
        return response(
            200,
            Some(rpc_error(
                id,
                -32602,
                &format!("Invalid _meta envelope for protocol revision {MODERN}"),
                Some(json!({"required":[PROTOCOL,CLIENT_CAPABILITIES]})),
            )),
        );
    }
    let local = host.deployment_mode == "local_trusted";
    let result:Result<(u16,Option<Value>,Option<String>),Error>=async {
        match method {
            "notifications/initialized"=>{d1::require_binding(pool,identity,binding,local).await?;Ok((202,None,None))},
            "initialize"=>{
                d1::require_binding(pool,identity,binding,local).await?;
                let requested=params["protocolVersion"].as_str();
                let selected=match requested{Some(version) if SUPPORTED.contains(&version)=>Some(version),None=>Some(MODERN),_=>None};
                let Some(selected)=selected else{return Ok((200,Some(rpc_error(id,-32022,&format!("Unsupported protocol version: {}",requested.unwrap_or("")),Some(json!({"supported":SUPPORTED,"requested":requested})))),None));};
                Ok((200,Some(rpc(id,json!({"protocolVersion":selected,"capabilities":{"tools":{"listChanged":false}},"serverInfo":server_info()}))),Some(selected.into())))
            },
            "server/discover"=>{
                d1::require_binding(pool,identity,binding,local).await?;
                if !is_modern||!params["_meta"][CLIENT_CAPABILITIES].is_object(){return Ok((200,Some(rpc_error(id,-32602,&format!("Invalid _meta envelope for protocol revision {MODERN}"),Some(json!({"required":[PROTOCOL,CLIENT_CAPABILITIES]})))),None));}
                Ok((200,Some(rpc(id,modern(json!({"supportedVersions":[MODERN],"capabilities":{"tools":{"listChanged":false}},"_meta":{(SERVER_INFO):server_info()}}),true,false,false))),Some(MODERN.into())))
            },
            "ping"=>{d1::require_binding(pool,identity,binding,local).await?;Ok((200,Some(rpc(id,if is_modern{modern(json!({}),false,false,false)}else{json!({})})),None))},
            "tools/list"=>{
                let tools=d1::list_tools(pool,identity,binding,local).await?;
                let result=if is_modern{
                    let offset=match params.get("cursor"){None=>Some(0),Some(Value::String(value))=>URL_SAFE_NO_PAD.decode(value).ok().and_then(|bytes|serde_json::from_slice::<Value>(&bytes).ok()).and_then(|value|value["offset"].as_u64()).and_then(|value|usize::try_from(value).ok()),_=>None};
                    let Some(offset)=offset else{return Ok((200,Some(rpc_error(id,-32602,"Invalid tools/list cursor",None)),None));};
                    let page=tools.iter().skip(offset).take(50).cloned().collect::<Vec<_>>();let next=offset.saturating_add(page.len());let mut result=json!({"tools":page});
                    if next<tools.len(){result["nextCursor"]=json!(URL_SAFE_NO_PAD.encode(json!({"offset":next}).to_string()));}modern(result,true,true,true)
                }else{json!({"tools":tools})};Ok((200,Some(rpc(id,result)),None))
            },
            "tools/call"=>{
                let Some(name)=params["name"].as_str() else{return Ok((200,Some(rpc_error(id,-32602,"Invalid params",None)),None));};
                if params.get("arguments").is_some_and(|value|!value.is_object()){return Ok((200,Some(rpc_error(id,-32602,"Invalid params",None)),None));}
                let args=params.get("arguments").cloned().unwrap_or_else(||json!({}));let call=d1::prepare_call(pool,identity,binding,name,&args,local).await?;
                let called=call_upstream(pool,identity,&call.access,&call.external_tool_name,&args,host).await;
                match called {
                    Ok(result)=>{d1::finish_call(pool,&call,Ok(&result)).await?;Ok((200,Some(rpc(id,if is_modern{modern(result,false,false,true)}else{result})),None))},
                    Err(error)=>{let code=match &error{Error::Runtime(code)=>*code,_=>"mcp_tool_failed"};d1::finish_call(pool,&call,Err(code)).await?;Err(error)},
                }
            },
            _ if body.get("id").is_none()=>{d1::require_binding(pool,identity,binding,local).await?;Ok((202,None,None))},
            _=>Ok((200,Some(rpc_error(id,-32601,"Method not found",None)),None)),
        }
    }.await;
    match result {
        Ok((status, body, revision)) => {
            let mut result = response(status, body);
            if let Some(revision) = revision {
                result
                    .headers
                    .insert("MCP-Protocol-Version".into(), revision);
            }
            result
        }
        Err(Error::Denied) => response(
            200,
            Some(rpc_error(
                id,
                -32001,
                "Managed MCP request is not authorized",
                None,
            )),
        ),
        Err(Error::Runtime(code)) => response(
            200,
            Some(rpc_error(
                id,
                -32002,
                "Managed MCP tool call failed",
                Some(json!({"code":code})),
            )),
        ),
        Err(Error::Database(_)) => {
            response(200, Some(rpc_error(id, -32603, "Internal error", None)))
        }
    }
}

async fn call_upstream(
    pool: &PgPool,
    identity: &Identity,
    access: &Access,
    name: &str,
    args: &Value,
    host: &Host,
) -> Result<Value, Error> {
    let credentials = d1::credentials(
        pool,
        identity,
        access,
        host.deployment_mode == "local_trusted",
    )
    .await?;
    if access.transport == "stdio" {
        let launch = security::stdio_launch(access, &credentials.connection, host)?;
        return stdio::call(
            launch,
            host,
            identity,
            name,
            args,
            Duration::from_millis(access.startup_timeout_ms),
            Duration::from_millis(access.tool_timeout_ms),
        )
        .await;
    }
    let target = security::http_options(
        access,
        &credentials.connection,
        credentials.oauth.as_ref(),
        host,
    )?;
    match http::call(
        &target,
        name,
        args,
        access.startup_timeout_ms,
        access.tool_timeout_ms,
    )
    .await
    {
        Err(Error::Runtime("mcp_upstream_unauthorized")) if credentials.oauth.is_some() => {
            let baseline = credentials.oauth.as_ref().unwrap();
            oauth::refresh(pool, identity, access, baseline, host).await?;
            let credentials = d1::credentials(
                pool,
                identity,
                access,
                host.deployment_mode == "local_trusted",
            )
            .await?;
            let refreshed = security::http_options(
                access,
                &credentials.connection,
                credentials.oauth.as_ref(),
                host,
            )?;
            let result = http::call(
                &refreshed,
                name,
                args,
                access.startup_timeout_ms,
                access.tool_timeout_ms,
            )
            .await;
            if matches!(result, Err(Error::Runtime("mcp_upstream_unauthorized"))) {
                d1::mark_needs_reauth(
                    pool,
                    identity,
                    access,
                    "upstream_unauthorized",
                    host.deployment_mode == "local_trusted",
                )
                .await?;
            }
            result
        }
        result => result,
    }
}
