import protobuf from "protobufjs/minimal.js";
import { requireFact, signed64 } from "./model.js";
const { Writer, Reader } = protobuf;
// Wire fields are pinned to Gonka 136041..., see provenance/tx.proto.
export const ROUTE = "/inference.inference.MsgSetClaimRecipients";
export const CLAIM = "/inference.inference.MsgClaimRewards";
export function encodeNative(type: string, value: any): Uint8Array {
  const w = Writer.create().uint32(10).string(value.creator);
  if (type === ROUTE) {
    for (const e of value.entries)
      w.uint32(18)
        .fork()
        .uint32(8)
        .uint64(e.epoch)
        .uint32(18)
        .string(e.recipient)
        .ldelim();
  } else {
    requireFact(
      type === CLAIM,
      "UNSUPPORTED_MESSAGE",
      "Unknown native message",
    );
    signed64(value.seed);
    w.uint32(16).int64(value.seed).uint32(24).uint64(value.epoch_index);
  }
  return w.finish();
}
export function decodeNative(type: string, bytes: Uint8Array): any {
  const r = Reader.create(bytes),
    value: any = { creator: "" };
  if (type === ROUTE) value.entries = [];
  else {
    value.seed = "0";
    value.epoch_index = "0";
  }
  while (r.pos < r.len) {
    const tag = r.uint32();
    switch (tag >>> 3) {
      case 1:
        value.creator = r.string();
        break;
      case 2:
        if (type === CLAIM) {
          value.seed = r.int64().toString();
          break;
        }
        const end = r.uint32() + r.pos,
          e: any = { epoch: "0", recipient: "" };
        while (r.pos < end) {
          const t = r.uint32();
          if (t >>> 3 === 1) e.epoch = r.uint64().toString();
          else if (t >>> 3 === 2) e.recipient = r.string();
          else r.skipType(t & 7);
        }
        value.entries.push(e);
        break;
      case 3:
        value.epoch_index = r.uint64().toString();
        break;
      default:
        r.skipType(tag & 7);
    }
  }
  return value;
}
