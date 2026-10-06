import { createTranscriptObjectStore, type TranscriptObjectHandle } from "./transcript-object-store.js";

const [root, handleJson, entryJson] = process.argv.slice(2);
if (!root || !handleJson || !entryJson) throw new Error("transcript_object_lock_worker_arguments_missing");

const handle = JSON.parse(handleJson) as TranscriptObjectHandle;
const entry = JSON.parse(entryJson);
await createTranscriptObjectStore(root).append(handle, entry);
