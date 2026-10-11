import type { PortName } from "../integrations/ports";

/**
 * Family notification channels (INTG-011; comms.md section 4 rule 14; ADR-0060). Email, SMS
 * and push reach a family member through the integration ports (`comms.email`, `comms.sms`,
 * `comms.push`, integrations/ports.ts), whose adapters are SES, a UK SMS gateway and Expo push,
 * each with a mock and a contract test. Providers report bounces, complaints, unregistered devices
 * and opt-outs in their own formats; adapters translate them into the provider-neutral
 * `FamilyChannelEvent` below, and these rules decide what each one does to the channel. Nothing
 * here depends on a provider.
 */

export const FAMILY_CHANNEL_KINDS = ["email", "sms", "push"] as const;
export type FamilyChannelKind = (typeof FAMILY_CHANNEL_KINDS)[number];

export const FAMILY_CHANNEL_PORTS: Readonly<Record<FamilyChannelKind, PortName>> = {
  email: "comms.email",
  sms: "comms.sms",
  push: "comms.push",
};

export type ChannelSuspension = "hard_bounce" | "complaint" | "device_not_registered";

/** One way of reaching one family member, as stored with their contact record. */
export interface FamilyChannelState {
  readonly id: string;
  readonly contactId: string;
  readonly kind: FamilyChannelKind;
  /** Email address, E.164 mobile number, or device push token. */
  readonly address: string;
  /** When the family member proved they hold the address (link or code); push tokens at sign-in. */
  readonly verifiedAt: Date | null;
  /** The family member switched update notifications on for this channel (opt-in). */
  readonly updatesOn: boolean;
  readonly optedOutAt: Date | null;
  readonly suspendedAt: Date | null;
  readonly suspendedReason: ChannelSuspension | null;
}

export type ChannelUnusableReason =
  | "not_verified"
  | "updates_off"
  | "opted_out"
  | ChannelSuspension;

export type ChannelUsability =
  | { readonly usable: true }
  | { readonly usable: false; readonly reason: ChannelUnusableReason };

/** Whether a channel may carry an update notification now. */
export function familyChannelUsability(state: FamilyChannelState): ChannelUsability {
  if (state.optedOutAt !== null) return { usable: false, reason: "opted_out" };
  if (state.suspendedAt !== null && state.suspendedReason !== null) {
    return { usable: false, reason: state.suspendedReason };
  }
  if (state.verifiedAt === null) return { usable: false, reason: "not_verified" };
  if (!state.updatesOn) return { usable: false, reason: "updates_off" };
  return { usable: true };
}

// ------------------------------------------------------------------------------------------------
// Provider-neutral channel events (bounce, complaint, opt-out)
// ------------------------------------------------------------------------------------------------

export type FamilyChannelEvent =
  | { readonly type: "bounced"; readonly permanent: boolean; readonly at: Date }
  | { readonly type: "complained"; readonly at: Date }
  | { readonly type: "device_not_registered"; readonly at: Date }
  | {
      readonly type: "opted_out";
      readonly via: "sms_reply" | "email_link" | "portal";
      readonly at: Date;
    }
  | { readonly type: "opted_in"; readonly via: "sms_reply" | "portal"; readonly at: Date }
  | { readonly type: "verified"; readonly at: Date }
  | { readonly type: "address_changed"; readonly address: string; readonly at: Date };

/** Audit events written for each change (comms.md section 6). */
export type FamilyChannelAuditEvent =
  | "comms.channel.suspended"
  | "comms.channel.opted_out"
  | "comms.channel.opted_in"
  | "comms.channel.verified"
  | "comms.channel.address_changed";

export type FamilyChannelEventResult =
  | {
      readonly changed: true;
      readonly state: FamilyChannelState;
      readonly audit: FamilyChannelAuditEvent;
    }
  | { readonly changed: false; readonly state: FamilyChannelState; readonly why: string };

/**
 * What a provider event does to a channel. A permanent bounce, a complaint (the recipient marked
 * the message as spam) or an unregistered device suspends the channel until the address changes;
 * a permanent email bounce or an SMS the gateway reports as undeliverable counts as a hard bounce;
 * a temporary bounce changes nothing, because delivery retries with backoff (`deliveryOutcome` in
 * integrations/ports.ts). An opt-out from any route stops update notifications at once; opting back
 * in is done in the portal, or by replying START from the same phone.
 */
export function applyFamilyChannelEvent(
  state: FamilyChannelState,
  event: FamilyChannelEvent,
): FamilyChannelEventResult {
  const unchanged = (why: string): FamilyChannelEventResult => ({ changed: false, state, why });
  switch (event.type) {
    case "bounced":
      if (!event.permanent)
        return unchanged("A temporary bounce is retried; the channel stays on.");
      if (state.kind === "push") return unchanged("Push reports unregistered devices instead.");
      return suspend(state, "hard_bounce", event.at);
    case "complained":
      if (state.kind !== "email") return unchanged("Only email reports complaints.");
      return suspend(state, "complaint", event.at);
    case "device_not_registered":
      if (state.kind !== "push") return unchanged("Only push reports unregistered devices.");
      return suspend(state, "device_not_registered", event.at);
    case "opted_out":
      if (state.optedOutAt !== null) return unchanged("Already opted out.");
      if (event.via === "sms_reply" && state.kind !== "sms") {
        return unchanged("An SMS reply opts out of SMS only.");
      }
      return {
        changed: true,
        state: { ...state, optedOutAt: event.at, updatesOn: false },
        audit: "comms.channel.opted_out",
      };
    case "opted_in":
      if (event.via === "sms_reply" && state.kind !== "sms") {
        return unchanged("An SMS reply opts in to SMS only.");
      }
      if (state.optedOutAt === null && state.updatesOn) return unchanged("Already on.");
      return {
        changed: true,
        state: { ...state, optedOutAt: null, updatesOn: true },
        audit: "comms.channel.opted_in",
      };
    case "verified":
      return {
        changed: true,
        state: { ...state, verifiedAt: event.at },
        audit: "comms.channel.verified",
      };
    case "address_changed":
      // A new address must be proved again; a suspension belonged to the old address.
      return {
        changed: true,
        state: {
          ...state,
          address: event.address,
          verifiedAt: null,
          suspendedAt: null,
          suspendedReason: null,
        },
        audit: "comms.channel.address_changed",
      };
  }
}

function suspend(
  state: FamilyChannelState,
  reason: ChannelSuspension,
  at: Date,
): FamilyChannelEventResult {
  if (state.suspendedReason === reason) {
    return { changed: false, state, why: "Already suspended for this reason." };
  }
  return {
    changed: true,
    state: { ...state, suspendedAt: at, suspendedReason: reason },
    audit: "comms.channel.suspended",
  };
}

// ------------------------------------------------------------------------------------------------
// SMS replies
// ------------------------------------------------------------------------------------------------

/** Replies that opt out of SMS, the keywords UK and international gateways commonly honour. */
export const SMS_OPT_OUT_KEYWORDS = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"];
export const SMS_OPT_IN_KEYWORDS = ["START", "UNSTOP"];

/**
 * What an inbound SMS reply asks for. Only a reply that is one keyword on its own counts, in any
 * case and with surrounding spaces or a full stop; anything else is not read (replies are not a
 * messaging channel, and the gateway keeps no conversation).
 */
export function classifySmsReply(text: string): "opt_out" | "opt_in" | "not_a_keyword" {
  let word = text.trim().toUpperCase();
  while (word.endsWith(".") || word.endsWith("!")) word = word.slice(0, -1).trimEnd();
  if (SMS_OPT_OUT_KEYWORDS.includes(word)) return "opt_out";
  if (SMS_OPT_IN_KEYWORDS.includes(word)) return "opt_in";
  return "not_a_keyword";
}

// ------------------------------------------------------------------------------------------------
// Addresses and click-to-call
// ------------------------------------------------------------------------------------------------

const isAsciiDigit = (ch: string) => ch >= "0" && ch <= "9";

/** The longest email address the standards allow (RFC 5321 path limit). */
export const MAX_EMAIL_ADDRESS_LENGTH = 254;

/**
 * A plausible email address: one "@", something before it, a domain with a dot that does not
 * start or end the domain, and no spaces. Proof of the address comes from verification, not
 * from this check.
 */
export function isPlausibleEmail(address: string): boolean {
  if (address.length === 0 || address.length > MAX_EMAIL_ADDRESS_LENGTH) return false;
  let at = -1;
  for (let i = 0; i < address.length; i++) {
    const ch = address[i] as string;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") return false;
    if (ch === "@") {
      if (at >= 0) return false;
      at = i;
    }
  }
  if (at <= 0 || at === address.length - 1) return false;
  const domain = address.slice(at + 1);
  const dot = domain.indexOf(".");
  return dot > 0 && !domain.endsWith(".") && !domain.includes("..");
}

/**
 * A phone number in E.164 form ("+447700900123"), from what a person typed. UK numbers written
 * nationally ("07700 900123") become +44 and "00" becomes "+"; spaces, hyphens and brackets are
 * dropped. Returns null
 * for anything that is not 8 to 15 digits after the "+" (ITU-T E.164).
 */
export function toE164(raw: string): string | null {
  let digits = "";
  let plus = false;
  for (const ch of raw.trim()) {
    if (isAsciiDigit(ch)) digits += ch;
    else if (ch === "+" && digits.length === 0 && !plus) plus = true;
    else if (ch !== " " && ch !== "-" && ch !== "(" && ch !== ")") return null;
  }
  if (!plus) {
    // "00" is the international prefix dialled from the UK; a single "0" starts a UK number.
    if (digits.startsWith("00")) digits = digits.slice(2);
    else if (digits.startsWith("0")) digits = `44${digits.slice(1)}`;
    else return null;
  }
  if (digits.length < 8 || digits.length > 15 || digits.startsWith("0")) return null;
  return `+${digits}`;
}

/** A UK mobile number in E.164 form: +44 7, then 9 digits. */
export function isUkMobile(e164: string): boolean {
  return e164.startsWith("+447") && e164.length === 13;
}

/** Whether an address suits its channel. Push tokens are checked by the push adapter. */
export function checkFamilyChannelAddress(kind: FamilyChannelKind, address: string): boolean {
  if (kind === "email") return isPlausibleEmail(address);
  if (kind === "sms") return toE164(address) === address;
  return address.trim().length > 0;
}

/**
 * A click-to-call link for the home's own number (telephony, INTG-011): `tel:` with the E.164
 * number (RFC 3966). Only organisation numbers are offered; a family member's number is never put
 * in a link.
 */
export function clickToCallLink(phone: string): string | null {
  const e164 = toE164(phone);
  return e164 === null ? null : `tel:${e164}`;
}
