//! Bounded proof of a successful, fully written provider effect RPC.
use crate::receipts::ReceiptIdentity;
use crate::{RequestId, SessionObservation, TransportError};
use serde_json::Value;

pub struct EffectResponseReceipt {
    identity: ReceiptIdentity,
    request_id: RequestId,
    thread: String,
    turn: Option<String>,
}
impl EffectResponseReceipt {
    pub fn thread_id(&self) -> &str {
        &self.thread
    }
    pub fn turn_id(&self) -> Option<&str> {
        self.turn.as_deref()
    }
    pub fn matches_execution(&self, run: &str, attempt: &str, owner: &str) -> bool {
        self.identity.matches(run, attempt, owner)
    }
    pub fn matches_connection_claim(
        &self,
        run: &str,
        attempt: &str,
        owner: &str,
        connection_epoch: i32,
        claim_id: &str,
    ) -> bool {
        self.identity
            .matches_connection_claim(run, attempt, owner, connection_epoch, claim_id)
    }
    pub fn correlation(&self) -> String {
        format!(
            "{}:{:?}",
            self.identity.connection_receipt_id(),
            self.request_id
        )
    }
    pub fn connection_receipt_id(&self) -> &str {
        self.identity.connection_receipt_id()
    }
}

pub(crate) struct PendingEffectResponse {
    id: RequestId,
    method: String,
    thread: Option<String>,
    written: bool,
    response: Option<(String, Option<String>)>,
}
impl PendingEffectResponse {
    pub(crate) fn new(id: RequestId, method: &str, params: &Value) -> Result<Self, TransportError> {
        let thread = if method == "turn/start" {
            let value = params["threadId"]
                .as_str()
                .ok_or(TransportError::InvalidTurnReceipt)?;
            valid_locator(value)?;
            Some(value.to_owned())
        } else {
            None
        };
        Ok(Self {
            id,
            method: method.into(),
            thread,
            written: false,
            response: None,
        })
    }
    pub(crate) fn written(&mut self, id: Option<&RequestId>) {
        if id == Some(&self.id) {
            self.written = true;
        }
    }
    pub(crate) fn observe(
        &mut self,
        observation: &SessionObservation,
    ) -> Result<(), TransportError> {
        if let SessionObservation::Completed {
            id,
            method,
            outcome,
        } = observation
        {
            if id != &self.id {
                return Ok(());
            }
            if method != &self.method || self.response.is_some() {
                return Err(TransportError::InvalidTurnReceipt);
            }
            let Ok(value) = outcome else { return Ok(()) };
            let (thread, turn) = if method == "thread/start" {
                if value["thread"]["ephemeral"] != false {
                    return Err(TransportError::InvalidTurnReceipt);
                }
                (
                    value["thread"]["id"]
                        .as_str()
                        .ok_or(TransportError::InvalidTurnReceipt)?
                        .to_owned(),
                    None,
                )
            } else {
                (
                    self.thread
                        .clone()
                        .ok_or(TransportError::InvalidTurnReceipt)?,
                    Some(
                        value["turn"]["id"]
                            .as_str()
                            .ok_or(TransportError::InvalidTurnReceipt)?
                            .to_owned(),
                    ),
                )
            };
            valid_locator(&thread)?;
            if let Some(turn) = &turn {
                valid_locator(turn)?;
            }
            self.response = Some((thread, turn));
        }
        Ok(())
    }
    pub(crate) fn ready(&self) -> bool {
        self.written && self.response.is_some()
    }
    pub(crate) fn finish(self, identity: ReceiptIdentity) -> EffectResponseReceipt {
        let (thread, turn) = self.response.expect("ready response");
        EffectResponseReceipt {
            identity,
            request_id: self.id,
            thread,
            turn,
        }
    }
}

fn valid_locator(value: &str) -> Result<(), TransportError> {
    if value.is_empty() || value.len() > 4096 {
        Err(TransportError::InvalidTurnReceipt)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn completed(id: i64, method: &str, value: Value) -> SessionObservation {
        SessionObservation::Completed {
            id: RequestId::Number(id),
            method: method.into(),
            outcome: Ok(value),
        }
    }
    #[test]
    fn proof_requires_both_exact_response_and_complete_write_in_either_order() {
        for write_first in [true, false] {
            let id = RequestId::Number(7);
            let mut proof = PendingEffectResponse::new(
                id.clone(),
                "turn/start",
                &json!({"threadId":" opaque-thread "}),
            )
            .unwrap();
            if write_first {
                proof.written(Some(&id));
            }
            assert!(!proof.ready());
            proof
                .observe(&completed(
                    7,
                    "turn/start",
                    json!({"turn":{"id":" opaque-turn "}}),
                ))
                .unwrap();
            assert_eq!(proof.ready(), write_first);
            proof.written(Some(&id));
            assert!(proof.ready());
            let proof = proof.finish(ReceiptIdentity::unbound(
                "run".into(),
                "attempt".into(),
                "owner".into(),
            ));
            assert_eq!(proof.thread_id(), " opaque-thread ");
            assert_eq!(proof.turn_id(), Some(" opaque-turn "));
            assert!(proof.matches_execution("run", "attempt", "owner"));
            assert!(!proof.matches_execution("run", "attempt", "other"));
        }
    }
    #[test]
    fn wrong_request_or_partial_write_cannot_mint_proof() {
        let mut proof =
            PendingEffectResponse::new(RequestId::Number(1), "thread/start", &json!({})).unwrap();
        proof.written(Some(&RequestId::Number(2)));
        proof
            .observe(&completed(
                2,
                "thread/start",
                json!({"thread":{"id":"other","ephemeral":false}}),
            ))
            .unwrap();
        assert!(!proof.ready());
        proof
            .observe(&completed(
                1,
                "thread/start",
                json!({"thread":{"id":"exact","ephemeral":false}}),
            ))
            .unwrap();
        assert!(!proof.ready());
        proof.written(Some(&RequestId::Number(1)));
        assert!(proof.ready());
    }
    #[test]
    fn wrong_method_ephemeral_or_invalid_locator_fail_closed() {
        for (method, value) in [
            ("turn/start", json!({"turn":{"id":"t"}})),
            (
                "thread/start",
                json!({"thread":{"id":"t","ephemeral":true}}),
            ),
            (
                "thread/start",
                json!({"thread":{"id":"","ephemeral":false}}),
            ),
        ] {
            let mut proof =
                PendingEffectResponse::new(RequestId::Number(1), "thread/start", &json!({}))
                    .unwrap();
            assert!(proof.observe(&completed(1, method, value)).is_err());
        }
    }
}
