//! Process-local native live events. This is the existing EventEmitter contract
//! implemented in Rust, not a durable event store or a business callback.
mod websocket;
mod forward;
pub(crate) use websocket::{bearer_token,organization_from_path,upgrade};
pub(crate) use forward::forward_handler;
pub const FORWARD_ACTION:&str="live.events.forward";
pub const FORWARD_ACTOR:&str="node-live-events-transport";
use serde::{Deserialize,Serialize};
use serde_json::Value;
use std::{collections::HashMap,sync::{Arc,Mutex,MutexGuard,Weak}};
use tokio::sync::{broadcast,watch};

pub const EVENT_TYPES:&[&str]=&["heartbeat.run.queued","heartbeat.run.status","heartbeat.run.event","heartbeat.run.log","agent.status","activity.logged","issue.content_updated"];
const SUBSCRIBER_BUFFER:usize=1024;

#[derive(Clone,Debug,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct LiveEvent{
    pub id:u64,
    #[serde(skip_serializing_if="Option::is_none")]
    pub dedupe_key:Option<String>,
    pub org_id:String,
    #[serde(rename="type")]
    pub event_type:String,
    pub created_at:String,
    pub payload:Value,
}
#[derive(Debug,thiserror::Error,PartialEq,Eq)]
pub enum LiveEventError{
    #[error("Live event organization is invalid")] InvalidOrganization,
    #[error("Live event type is invalid")] InvalidType,
    #[error("Live event payload must be an object")] InvalidPayload,
    #[error("Existing live event frame is invalid")] InvalidFrame,
    #[error("Live event publisher is closed")] Closed,
}
#[derive(Clone)]
pub struct LiveEventPublisher{inner:Arc<Mutex<State>>,shutdown:watch::Sender<bool>}
struct State{next_id:u64,closed:bool,organizations:HashMap<String,broadcast::Sender<Arc<LiveEvent>>>}
impl Default for LiveEventPublisher{fn default()->Self{let(shutdown,_)=watch::channel(false);Self{inner:Arc::new(Mutex::new(State{next_id:0,closed:false,organizations:HashMap::new()})),shutdown}}}
fn lock<T>(mutex:&Mutex<T>)->MutexGuard<'_,T>{mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)}
fn organization(org:&str)->bool{org=="*"||uuid::Uuid::parse_str(org).is_ok()}
fn validate(org:&str,event_type:&str,payload:&Value)->Result<(),LiveEventError>{if !organization(org){return Err(LiveEventError::InvalidOrganization);}if !EVENT_TYPES.contains(&event_type){return Err(LiveEventError::InvalidType);}if !payload.is_object(){return Err(LiveEventError::InvalidPayload);}Ok(())}
fn timestamp()->String{let now=time::OffsetDateTime::now_utc();format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",now.year(),u8::from(now.month()),now.day(),now.hour(),now.minute(),now.second(),now.millisecond())}
impl LiveEventPublisher{
    pub fn new()->Self{Self::default()}
    /// Called by a native owner after its durable write, with its trusted org
    /// and already-redacted provider/log payload. No Node dependency is used.
    pub fn publish(&self,org_id:&str,event_type:&str,payload:Value,dedupe_key:Option<&str>)->Result<LiveEvent,LiveEventError>{
        validate(org_id,event_type,&payload)?;self.dispatch(LiveEvent{id:0,org_id:org_id.into(),event_type:event_type.into(),created_at:timestamp(),payload,dedupe_key:dedupe_key.filter(|key|!key.is_empty()).map(str::to_owned)})
    }
    pub fn publish_global(&self,event_type:&str,payload:Value,dedupe_key:Option<&str>)->Result<LiveEvent,LiveEventError>{self.publish("*",event_type,payload,dedupe_key)}
    /// Temporary one-way legacy transport. Keep existing facts/timestamp/key;
    /// allocate the id on the same Rust sequence as native publishers. This is
    /// never called as a fallback by a native business owner.
    pub fn forward_existing(&self,event:LiveEvent)->Result<LiveEvent,LiveEventError>{
        validate(&event.org_id,&event.event_type,&event.payload)?;
        if event.id==0||event.dedupe_key.as_ref().is_some_and(String::is_empty)||time::OffsetDateTime::parse(&event.created_at,&time::format_description::well_known::Rfc3339).is_err(){return Err(LiveEventError::InvalidFrame);}self.dispatch(event)
    }
    fn dispatch(&self,mut event:LiveEvent)->Result<LiveEvent,LiveEventError>{let mut state=lock(&self.inner);if state.closed{return Err(LiveEventError::Closed);}state.next_id=state.next_id.checked_add(1).ok_or(LiveEventError::Closed)?;event.id=state.next_id;
        if let Some(sender)=state.organizations.get(&event.org_id){let _=sender.send(Arc::new(event.clone()));}Ok(event)
    }
    pub(crate) fn subscribe(&self,org_id:&str)->Result<Subscription,LiveEventError>{if !organization(org_id){return Err(LiveEventError::InvalidOrganization);}let mut state=lock(&self.inner);if state.closed{return Err(LiveEventError::Closed);}let receiver=if let Some(sender)=state.organizations.get(org_id){sender.subscribe()}else{let(sender,receiver)=broadcast::channel(SUBSCRIBER_BUFFER);state.organizations.insert(org_id.into(),sender);receiver};Ok(Subscription{receiver,shutdown:self.shutdown.subscribe(),organization_id:org_id.into(),publisher:Arc::downgrade(&self.inner)})}
    /// Listener shutdown closes native sockets and drops their subscriptions.
    pub fn close(&self){let mut state=lock(&self.inner);state.closed=true;state.organizations.clear();self.shutdown.send_replace(true);}
}
pub(crate) struct Subscription{receiver:broadcast::Receiver<Arc<LiveEvent>>,shutdown:watch::Receiver<bool>,organization_id:String,publisher:Weak<Mutex<State>>}
impl Drop for Subscription{fn drop(&mut self){if let Some(publisher)=self.publisher.upgrade(){let mut state=lock(&publisher);if state.organizations.get(&self.organization_id).is_some_and(|sender|sender.receiver_count()<=1){state.organizations.remove(&self.organization_id);}}}}

#[cfg(test)]mod tests{
    use super::*;
    const ORG:&str="10000000-0000-4000-8000-000000000001";
    #[tokio::test]async fn sequence_org_scope_and_existing_frame_are_native(){let publisher=LiveEventPublisher::new();let mut subscriber=publisher.subscribe(ORG).unwrap();let first=publisher.publish(ORG,"agent.status",serde_json::json!({"status":"running"}),None).unwrap();publisher.publish("10000000-0000-4000-8000-000000000002","agent.status",serde_json::json!({}),None).unwrap();let third=publisher.forward_existing(LiveEvent{id:999,dedupe_key:Some("legacy:1".into()),org_id:ORG.into(),event_type:"activity.logged".into(),created_at:"2026-10-28T00:00:00.000Z".into(),payload:serde_json::json!({"action":"synthetic"})}).unwrap();assert_eq!(first.id,1);assert_eq!(third.id,3);assert_eq!(third.created_at,"2026-10-28T00:00:00.000Z");assert_eq!(subscriber.receiver.recv().await.unwrap().id,1);assert_eq!(subscriber.receiver.recv().await.unwrap().id,3);assert!(subscriber.receiver.try_recv().is_err());}
    #[test]fn invalid_events_never_enter_the_bus(){let publisher=LiveEventPublisher::new();assert_eq!(publisher.publish("bad-org","agent.status",serde_json::json!({}),None).unwrap_err(),LiveEventError::InvalidOrganization);assert_eq!(publisher.publish(ORG,"unknown",serde_json::json!({}),None).unwrap_err(),LiveEventError::InvalidType);assert_eq!(publisher.publish(ORG,"agent.status",Value::Null,None).unwrap_err(),LiveEventError::InvalidPayload);}
    #[tokio::test]async fn unsubscribe_and_shutdown_remove_native_listeners(){let publisher=LiveEventPublisher::new();let subscriber=publisher.subscribe(ORG).unwrap();assert_eq!(lock(&publisher.inner).organizations.len(),1);drop(subscriber);assert!(lock(&publisher.inner).organizations.is_empty());let mut subscriber=publisher.subscribe(ORG).unwrap();publisher.close();subscriber.shutdown.changed().await.unwrap();assert!(*subscriber.shutdown.borrow());assert_eq!(publisher.publish(ORG,"agent.status",serde_json::json!({}),None).unwrap_err(),LiveEventError::Closed);}
}
