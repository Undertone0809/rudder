//! Opt-in Actix routes. Authentication middleware must insert TrustedPrincipal.
//! No request header, cookie, or JSON property can manufacture a board grant.

use crate::{AgentIdentity, AgentKeyStore, BoardGrant, KeyError};
use actix_web::{Error, FromRequest, HttpMessage, HttpRequest, HttpResponse, dev::Payload, web};
use serde::Deserialize;
use std::future::{Ready, ready};

#[derive(Clone, Debug)]
pub enum TrustedPrincipal {
    Board(BoardGrant),
    Agent(AgentIdentity),
}

impl FromRequest for BoardGrant {
    type Error = Error;
    type Future = Ready<Result<Self, Self::Error>>;

    fn from_request(req: &HttpRequest, _: &mut Payload) -> Self::Future {
        let result = match req.extensions().get::<TrustedPrincipal>() {
            Some(TrustedPrincipal::Board(grant)) => Ok(grant.clone()),
            Some(TrustedPrincipal::Agent(_)) => {
                Err(actix_web::error::InternalError::from_response(
                    "Board access required",
                    HttpResponse::Forbidden()
                        .json(serde_json::json!({"error":"Board access required"})),
                )
                .into())
            }
            None => Err(KeyError::Unauthorized.into()),
        };
        ready(result)
    }
}

fn default_name() -> String {
    "default".into()
}
#[derive(Deserialize)]
struct CreateKey {
    #[serde(default = "default_name")]
    name: String,
}

pub fn configure(config: &mut web::ServiceConfig) {
    config
        .service(
            web::resource("/agents/{id}/keys")
                .route(web::get().to(list))
                .route(web::post().to(create)),
        )
        .service(web::resource("/agents/{id}/keys/{key_id}").route(web::delete().to(revoke)));
}

async fn list(
    store: web::Data<AgentKeyStore>,
    grant: BoardGrant,
    agent: web::Path<String>,
) -> Result<HttpResponse, KeyError> {
    Ok(HttpResponse::Ok().json(store.list(&grant, &agent).await?))
}
async fn create(
    store: web::Data<AgentKeyStore>,
    grant: BoardGrant,
    agent: web::Path<String>,
    input: web::Json<CreateKey>,
) -> Result<HttpResponse, KeyError> {
    Ok(HttpResponse::Created().json(store.create(&grant, &agent, &input.name).await?))
}
async fn revoke(
    store: web::Data<AgentKeyStore>,
    grant: BoardGrant,
    path: web::Path<(String, String)>,
) -> Result<HttpResponse, KeyError> {
    store.revoke(&grant, &path.0, &path.1).await?;
    Ok(HttpResponse::Ok().json(serde_json::json!({"ok":true})))
}
