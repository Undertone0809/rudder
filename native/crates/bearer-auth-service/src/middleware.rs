use crate::{BearerAuthenticator, TrustedActor};
use actix_service::{Service, Transform, forward_ready};
use actix_web::{
    Error, HttpMessage, HttpResponse, ResponseError,
    body::{EitherBody, MessageBody},
    dev::{ServiceRequest, ServiceResponse},
};
use std::{
    future::{Future, Ready, ready},
    pin::Pin,
    rc::Rc,
};

#[derive(Clone)]
pub struct BearerAuth {
    authenticator: BearerAuthenticator,
}
impl BearerAuth {
    pub fn new(authenticator: BearerAuthenticator) -> Self {
        Self { authenticator }
    }
}

impl<S, B> Transform<S, ServiceRequest> for BearerAuth
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
    B: MessageBody + 'static,
{
    type Response = ServiceResponse<EitherBody<B>>;
    type Error = Error;
    type InitError = ();
    type Transform = BearerAuthService<S>;
    type Future = Ready<Result<Self::Transform, Self::InitError>>;
    fn new_transform(&self, service: S) -> Self::Future {
        ready(Ok(BearerAuthService {
            service: Rc::new(service),
            authenticator: self.authenticator.clone(),
        }))
    }
}

pub struct BearerAuthService<S> {
    service: Rc<S>,
    authenticator: BearerAuthenticator,
}
impl<S, B> Service<ServiceRequest> for BearerAuthService<S>
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
    B: MessageBody + 'static,
{
    type Response = ServiceResponse<EitherBody<B>>;
    type Error = Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>>>>;
    forward_ready!(service);
    fn call(&self, request: ServiceRequest) -> Self::Future {
        let service = self.service.clone();
        let authenticator = self.authenticator.clone();
        Box::pin(async move {
            // Trusted extensions are always replaced by this authentication pass.
            request.extensions_mut().remove::<TrustedActor>();
            let headers = (
                single_header(&request, "authorization"),
                single_header(&request, "x-rudder-agent-id"),
                single_header(&request, "x-rudder-run-id"),
            );
            let (authorization, agent, run) =
                match headers {
                    (Ok(auth), Ok(agent), Ok(run)) => (auth, agent, run),
                    _ => {
                        return Ok(request
                            .into_response(HttpResponse::BadRequest().json(
                                serde_json::json!({"error":"Invalid authentication headers"}),
                            ))
                            .map_into_right_body());
                    }
                };
            let token = authorization
                .as_deref()
                .and_then(|value| value.split_once(' '))
                .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
                .map(|(_, token)| token.trim());
            let actor = match authenticator.authenticate(token, run.as_deref()).await {
                Ok(actor) => actor,
                Err(error) => {
                    return Ok(request
                        .into_response(error.error_response())
                        .map_into_right_body());
                }
            };
            if let Err(error) =
                actor.check_context(request.method().as_str(), agent.as_deref(), run.as_deref())
            {
                return Ok(request
                    .into_response(error.error_response())
                    .map_into_right_body());
            }
            request.extensions_mut().insert(actor);
            Ok(service.call(request).await?.map_into_left_body())
        })
    }
}

fn single_header(request: &ServiceRequest, name: &str) -> Result<Option<String>, ()> {
    let mut values = request.headers().get_all(name);
    let Some(value) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err(());
    }
    let text = value.to_str().map_err(|_| ())?;
    let bound = if name == "authorization" {
        16_400
    } else {
        1024
    };
    if text.len() > bound {
        return Err(());
    }
    let text = text.trim();
    Ok((!text.is_empty()).then(|| text.to_owned()))
}
// End of optional, fail-closed Actix authentication middleware.
