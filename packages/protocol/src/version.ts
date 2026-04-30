/**
 * Wire version. Bump when adding/changing message types or reply-tool args.
 *
 * History
 *   1 — initial: card/input_response/cancel_advisory + update_card,
 *       request_input, report_progress, report_step
 *   2 — adds `dispatch` reply tool (authored voice, optional peer addressing)
 *       and `peer_message` channel-event kind
 */
export const PROTOCOL_VERSION = 2 as const
export type ProtocolVersion = typeof PROTOCOL_VERSION
