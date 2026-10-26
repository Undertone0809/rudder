use rudder_d1_persistence::issue_core_writes::{
    IssueAssetObject, IssueAssetStorage, IssueAssetStorageFuture,
};
use serde::Deserialize;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::OnceCell;
use uuid::Uuid;

#[derive(Clone, Deserialize)]
#[serde(
    tag = "provider",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum IssueAssetStorageConfig {
    #[serde(rename = "local_disk")]
    LocalDisk { local_disk_base_dir: String },
    #[serde(rename = "s3")]
    S3 {
        bucket: String,
        region: String,
        endpoint: Option<String>,
        prefix: String,
        force_path_style: bool,
    },
}

enum ProviderConfig {
    LocalDisk {
        base_dir: PathBuf,
    },
    S3 {
        bucket: String,
        region: String,
        endpoint: Option<String>,
        prefix: String,
        force_path_style: bool,
    },
}

pub(crate) struct NativeIssueAssetStorage {
    config: ProviderConfig,
    s3_client: OnceCell<aws_sdk_s3::Client>,
}

impl NativeIssueAssetStorage {
    pub(crate) fn from_config(config: IssueAssetStorageConfig) -> Result<Arc<Self>, String> {
        let config = match config {
            IssueAssetStorageConfig::LocalDisk {
                local_disk_base_dir,
            } => {
                if local_disk_base_dir.trim().is_empty() {
                    return Err("local disk storage directory is required".to_owned());
                }
                ProviderConfig::LocalDisk {
                    base_dir: PathBuf::from(local_disk_base_dir),
                }
            }
            IssueAssetStorageConfig::S3 {
                bucket,
                region,
                endpoint,
                prefix,
                force_path_style,
            } => {
                if bucket.trim().is_empty() || region.trim().is_empty() {
                    return Err("S3 storage bucket and region are required".to_owned());
                }
                ProviderConfig::S3 {
                    bucket: bucket.trim().to_owned(),
                    region: region.trim().to_owned(),
                    endpoint: endpoint.filter(|value| !value.trim().is_empty()),
                    prefix: normalize_prefix(&prefix),
                    force_path_style,
                }
            }
        };
        Ok(Arc::new(Self {
            config,
            s3_client: OnceCell::new(),
        }))
    }

    async fn s3_client(&self) -> Result<&aws_sdk_s3::Client, String> {
        let ProviderConfig::S3 {
            region,
            endpoint,
            force_path_style,
            ..
        } = &self.config
        else {
            return Err("S3 client requested for local disk storage".to_owned());
        };
        Ok(self
            .s3_client
            .get_or_init(|| async {
                let shared_config = aws_config::defaults(aws_config::BehaviorVersion::latest())
                    .http_client(
                        aws_smithy_http_client::Builder::new()
                            .tls_provider(aws_smithy_http_client::tls::Provider::Rustls(
                                aws_smithy_http_client::tls::rustls_provider::CryptoMode::Ring,
                            ))
                            .build_https(),
                    )
                    .region(aws_config::Region::new(region.clone()))
                    .load()
                    .await;
                let mut builder = aws_sdk_s3::config::Builder::from(&shared_config)
                    .force_path_style(*force_path_style);
                if let Some(endpoint) = endpoint {
                    builder = builder.endpoint_url(endpoint.clone());
                }
                aws_sdk_s3::Client::from_conf(builder.build())
            })
            .await)
    }

    fn s3_object_key(&self, object_key: &str) -> Result<String, String> {
        let ProviderConfig::S3 { prefix, .. } = &self.config else {
            return Err("S3 object key requested for local disk storage".to_owned());
        };
        if prefix.is_empty() {
            Ok(object_key.to_owned())
        } else {
            Ok(format!("{prefix}/{object_key}"))
        }
    }
}

impl IssueAssetStorage for NativeIssueAssetStorage {
    fn provider(&self) -> &'static str {
        match &self.config {
            ProviderConfig::LocalDisk { .. } => "local_disk",
            ProviderConfig::S3 { .. } => "s3",
        }
    }

    fn get_object<'a>(
        &'a self,
        org_id: &'a str,
        object_key: &'a str,
    ) -> IssueAssetStorageFuture<'a, Result<IssueAssetObject, String>> {
        Box::pin(async move {
            ensure_org_object_key(org_id, object_key)?;
            match &self.config {
                ProviderConfig::LocalDisk { base_dir } => {
                    let path = resolve_local_path(base_dir, object_key)?;
                    let body = tokio::fs::read(path)
                        .await
                        .map_err(|error| format!("failed to read local storage object: {error}"))?;
                    Ok(IssueAssetObject {
                        body,
                        content_type: None,
                    })
                }
                ProviderConfig::S3 { bucket, .. } => {
                    let key = self.s3_object_key(object_key)?;
                    let response = self
                        .s3_client()
                        .await?
                        .get_object()
                        .bucket(bucket.as_str())
                        .key(key)
                        .send()
                        .await
                        .map_err(|error| format!("failed to read S3 storage object: {error}"))?;
                    let content_type = response.content_type().map(ToOwned::to_owned);
                    let body = response
                        .body
                        .collect()
                        .await
                        .map_err(|error| format!("failed to read S3 object body: {error}"))?
                        .into_bytes()
                        .to_vec();
                    Ok(IssueAssetObject { body, content_type })
                }
            }
        })
    }

    fn put_object<'a>(
        &'a self,
        org_id: &'a str,
        object_key: &'a str,
        content_type: &'a str,
        body: &'a [u8],
    ) -> IssueAssetStorageFuture<'a, Result<(), String>> {
        Box::pin(async move {
            ensure_org_object_key(org_id, object_key)?;
            match &self.config {
                ProviderConfig::LocalDisk { base_dir } => {
                    let target = resolve_local_path(base_dir, object_key)?;
                    let parent = target
                        .parent()
                        .ok_or_else(|| "local storage object has no parent directory".to_owned())?;
                    tokio::fs::create_dir_all(parent).await.map_err(|error| {
                        format!("failed to create local storage directory: {error}")
                    })?;
                    let temporary = target.with_file_name(format!(
                        "{}.tmp-{}",
                        target
                            .file_name()
                            .and_then(|name| name.to_str())
                            .unwrap_or("object"),
                        Uuid::new_v4()
                    ));
                    if let Err(error) = tokio::fs::write(&temporary, body).await {
                        let _ = tokio::fs::remove_file(&temporary).await;
                        return Err(format!("failed to write local storage object: {error}"));
                    }
                    if let Err(error) = tokio::fs::rename(&temporary, &target).await {
                        let _ = tokio::fs::remove_file(&temporary).await;
                        return Err(format!("failed to publish local storage object: {error}"));
                    }
                    Ok(())
                }
                ProviderConfig::S3 { bucket, .. } => {
                    let key = self.s3_object_key(object_key)?;
                    self.s3_client()
                        .await?
                        .put_object()
                        .bucket(bucket.as_str())
                        .key(key)
                        .content_type(content_type)
                        .content_length(body.len() as i64)
                        .body(aws_sdk_s3::primitives::ByteStream::from(body.to_vec()))
                        .send()
                        .await
                        .map_err(|error| format!("failed to write S3 storage object: {error}"))?;
                    Ok(())
                }
            }
        })
    }

    fn delete_object<'a>(
        &'a self,
        org_id: &'a str,
        object_key: &'a str,
    ) -> IssueAssetStorageFuture<'a, Result<(), String>> {
        Box::pin(async move {
            ensure_org_object_key(org_id, object_key)?;
            match &self.config {
                ProviderConfig::LocalDisk { base_dir } => {
                    let path = resolve_local_path(base_dir, object_key)?;
                    // The Node provider treats local deletes as idempotent, including missing files.
                    let _ = tokio::fs::remove_file(path).await;
                    Ok(())
                }
                ProviderConfig::S3 { bucket, .. } => {
                    let key = self.s3_object_key(object_key)?;
                    self.s3_client()
                        .await?
                        .delete_object()
                        .bucket(bucket.as_str())
                        .key(key)
                        .send()
                        .await
                        .map_err(|error| format!("failed to delete S3 storage object: {error}"))?;
                    Ok(())
                }
            }
        })
    }
}

fn ensure_org_object_key(org_id: &str, object_key: &str) -> Result<(), String> {
    if !object_key.starts_with(&format!("{org_id}/")) {
        return Err("Object does not belong to organization".to_owned());
    }
    if object_key.contains("..") {
        return Err("Invalid object key".to_owned());
    }
    Ok(())
}

fn resolve_local_path(base_dir: &Path, object_key: &str) -> Result<PathBuf, String> {
    let normalized = object_key.replace('\\', "/");
    let normalized = normalized.trim();
    if normalized.is_empty() || normalized.starts_with('/') {
        return Err("Invalid object key".to_owned());
    }
    let parts = normalized
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if parts.is_empty() || parts.iter().any(|part| matches!(*part, "." | "..")) {
        return Err("Invalid object key".to_owned());
    }
    Ok(parts
        .iter()
        .fold(base_dir.to_path_buf(), |path, part| path.join(part)))
}

fn normalize_prefix(prefix: &str) -> String {
    prefix
        .trim()
        .trim_start_matches('/')
        .trim_end_matches('/')
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::{
        IssueAssetStorage, IssueAssetStorageConfig, NativeIssueAssetStorage, ProviderConfig,
    };
    use actix_web::{App, HttpRequest, HttpResponse, HttpServer, http::header, web};
    use std::{
        net::TcpListener,
        sync::{Arc, Mutex},
    };

    #[derive(Clone, Debug)]
    struct CapturedS3Request {
        method: String,
        path: String,
        host: Option<String>,
        content_type: Option<String>,
        authorization: Option<String>,
        body: Vec<u8>,
    }

    async fn storage_with_loopback_s3_client(endpoint: &str) -> Arc<NativeIssueAssetStorage> {
        let storage = NativeIssueAssetStorage::from_config(IssueAssetStorageConfig::S3 {
            bucket: "rudder-asset-test-bucket".to_owned(),
            region: "us-east-1".to_owned(),
            endpoint: Some(endpoint.to_owned()),
            prefix: " /rudder-assets/v1/ ".to_owned(),
            force_path_style: true,
        })
        .expect("create S3 storage config");

        let ProviderConfig::S3 {
            region,
            endpoint,
            force_path_style,
            ..
        } = &storage.config
        else {
            panic!("expected S3 storage config");
        };

        let credentials = aws_sdk_s3::config::Credentials::new(
            "rudder-test-access-key",
            "rudder-test-secret-key",
            None,
            None,
            "issue-asset-storage-test",
        );
        let shared_config = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .http_client(
                aws_smithy_http_client::Builder::new()
                    .tls_provider(aws_smithy_http_client::tls::Provider::Rustls(
                        aws_smithy_http_client::tls::rustls_provider::CryptoMode::Ring,
                    ))
                    .build_https(),
            )
            .region(aws_config::Region::new(region.clone()))
            .credentials_provider(credentials)
            .load()
            .await;
        let mut builder =
            aws_sdk_s3::config::Builder::from(&shared_config).force_path_style(*force_path_style);
        if let Some(endpoint) = endpoint {
            builder = builder.endpoint_url(endpoint.clone());
        }
        assert!(
            storage
                .s3_client
                .set(aws_sdk_s3::Client::from_conf(builder.build()))
                .is_ok()
        );
        storage
    }

    fn assert_signed_request(request: &CapturedS3Request, expected_host: &str) {
        assert_eq!(request.host.as_deref(), Some(expected_host));
        assert!(
            !request
                .host
                .as_deref()
                .unwrap_or_default()
                .starts_with("rudder-asset-test-bucket."),
            "path-style addressing should keep the bucket out of Host"
        );
        let authorization = request
            .authorization
            .as_deref()
            .expect("AWS SDK should sign each S3 request");
        assert!(authorization.starts_with("AWS4-HMAC-SHA256 Credential=rudder-test-access-key/"));
        assert!(authorization.contains("/us-east-1/s3/aws4_request"));
        assert!(authorization.contains("SignedHeaders="));
        assert!(authorization.contains("Signature="));
    }

    #[test]
    fn parses_node_provider_configuration_for_both_supported_stores() {
        let local: IssueAssetStorageConfig = serde_json::from_str(
            r#"{"provider":"local_disk","localDiskBaseDir":"/tmp/rudder-assets"}"#,
        )
        .unwrap();
        let local = NativeIssueAssetStorage::from_config(local).unwrap();
        assert_eq!(local.provider(), "local_disk");

        let s3: IssueAssetStorageConfig = serde_json::from_str(
            r#"{"provider":"s3","bucket":"rudder-test","region":"us-east-1","endpoint":"https://objects.example.test","prefix":"rudder-assets","forcePathStyle":true}"#,
        )
        .unwrap();
        let s3 = NativeIssueAssetStorage::from_config(s3).unwrap();
        assert_eq!(s3.provider(), "s3");
    }

    #[actix_web::test]
    async fn s3_provider_performs_signed_prefixed_path_style_object_io() {
        let captured = Arc::new(Mutex::new(Vec::<CapturedS3Request>::new()));
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind S3 loopback fixture");
        let address = listener.local_addr().expect("read S3 fixture address");
        let expected_host = address.to_string();
        let server = HttpServer::new({
            let captured = captured.clone();
            move || {
                let captured = captured.clone();
                App::new().default_service(web::to(
                    move |request: HttpRequest, body: web::Bytes| {
                        let captured = captured.clone();
                        async move {
                            let record = CapturedS3Request {
                                method: request.method().to_string(),
                                path: request.uri().path().to_owned(),
                                host: request
                                    .headers()
                                    .get(header::HOST)
                                    .and_then(|value| value.to_str().ok())
                                    .map(ToOwned::to_owned),
                                content_type: request
                                    .headers()
                                    .get(header::CONTENT_TYPE)
                                    .and_then(|value| value.to_str().ok())
                                    .map(ToOwned::to_owned),
                                authorization: request
                                    .headers()
                                    .get(header::AUTHORIZATION)
                                    .and_then(|value| value.to_str().ok())
                                    .map(ToOwned::to_owned),
                                body: body.to_vec(),
                            };
                            let missing_object = record.path.ends_with("/missing.png");
                            let method = record.method.clone();
                            let key = record.path.clone();
                            captured.lock().expect("lock captured requests").push(record);

                            if method == "GET" && missing_object {
                                return HttpResponse::NotFound()
                                    .content_type("application/xml")
                                    .body(format!(
                                        "<Error><Code>NoSuchKey</Code><Message>missing test object</Message><Key>{key}</Key><RequestId>test-request</RequestId></Error>"
                                    ));
                            }

                            match method.as_str() {
                                "PUT" => HttpResponse::Ok().finish(),
                                "GET" => HttpResponse::Ok()
                                    .insert_header((header::CONTENT_TYPE, "image/png"))
                                    .body(b"fixture image bytes".to_vec()),
                                "DELETE" => HttpResponse::NoContent().finish(),
                                _ => HttpResponse::MethodNotAllowed().finish(),
                            }
                        }
                    },
                ))
            }
        })
        .workers(1)
        .disable_signals()
        .listen(listener)
        .expect("listen on S3 fixture")
        .run();
        let server_handle = server.handle();
        let server_task = actix_web::rt::spawn(server);

        let endpoint = format!("http://{address}");
        let storage = storage_with_loopback_s3_client(&endpoint).await;
        let org_id = "10000000-0000-4000-8000-000000000001";
        let object_key = format!("{org_id}/logos/profile.png");
        let expected_path_prefix = "/rudder-asset-test-bucket/rudder-assets/v1/";
        let expected_path = format!("{expected_path_prefix}{object_key}");
        let uploaded = b"signed S3 upload bytes";

        storage
            .put_object(org_id, &object_key, "image/png", uploaded)
            .await
            .expect("put object through AWS SDK");
        let object = storage
            .get_object(org_id, &object_key)
            .await
            .expect("get object through AWS SDK");
        assert_eq!(object.body, b"fixture image bytes");
        assert_eq!(object.content_type.as_deref(), Some("image/png"));
        storage
            .delete_object(org_id, &object_key)
            .await
            .expect("delete object through AWS SDK");

        let missing_key = format!("{org_id}/logos/missing.png");
        let error = storage
            .get_object(org_id, &missing_key)
            .await
            .err()
            .expect("missing object should remain a visible S3 error");
        assert!(
            error.contains("failed to read S3 storage object"),
            "{error}"
        );

        server_handle.stop(true).await;
        server_task
            .await
            .expect("join S3 fixture task")
            .expect("S3 fixture server");

        let requests = captured.lock().expect("read captured requests").clone();
        assert_eq!(requests.len(), 4);
        assert_eq!(
            requests
                .iter()
                .map(|request| request.method.as_str())
                .collect::<Vec<_>>(),
            vec!["PUT", "GET", "DELETE", "GET"]
        );
        for request in &requests {
            assert_signed_request(request, &expected_host);
            assert!(request.path.starts_with(expected_path_prefix));
        }
        assert_eq!(requests[0].path, expected_path);
        assert_eq!(requests[1].path, expected_path);
        assert_eq!(requests[2].path, expected_path);
        assert!(requests[3].path.ends_with(&missing_key));
        assert_eq!(requests[0].content_type.as_deref(), Some("image/png"));
        assert_eq!(requests[0].body, uploaded);
        assert!(requests[1].body.is_empty());
        assert!(requests[2].body.is_empty());
    }
}
