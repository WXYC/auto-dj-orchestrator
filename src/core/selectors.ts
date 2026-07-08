/**
 * Pure projections from the internal ActivationState to the wire contracts
 * (networking-spec §3.10.4 / §5.2.10–11).
 */
import type {
  AutoDJActivationSource,
  AutoDJDeactivateResponse,
  AutoDJDeviceSummary,
  AutoDJStatus,
} from '@wxyc/shared/auto-dj';
import { isActive, type Activation, type ActivationState } from './state.js';

function toSource(a: Activation): AutoDJActivationSource {
  return { source: a.source, userId: a.userId, userName: a.userName, detail: a.detail };
}

export function selectStatus(
  state: ActivationState,
  device: AutoDJDeviceSummary | null,
): AutoDJStatus {
  if (isActive(state)) {
    return {
      active: true,
      activatedBy: state.activatedBy ? toSource(state.activatedBy) : undefined,
      activatedAt: state.activatedBy?.at,
      showId: state.showId,
      currentTrack: state.currentTrack,
      device,
    };
  }
  return {
    active: false,
    lastDeactivatedAt: state.lastDeactivatedBy?.at,
    lastDeactivatedBy: state.lastDeactivatedBy ? toSource(state.lastDeactivatedBy) : undefined,
    device,
  };
}

/**
 * Reduce a full {@link AutoDJStatus} to the projection served to authenticated
 * users below the `dj` role (networking-spec §3.10.4: "`dj` role or higher for
 * full status").
 *
 * This is an ALLOWLIST, not a denylist: it copies only the below-`dj`-safe
 * fields and drops everything else, so it fails CLOSED. The identity/internal
 * fields — `activatedBy` and `lastDeactivatedBy` (the activating / last
 * deactivating DJ's Better Auth `userId`) and the internal `showId` — are absent
 * by construction in both the active and inactive branches. A field later added
 * to the `AutoDJStatus` schema is hidden from members by default rather than
 * leaked, and the compile-time tie below forces each new field to be classified.
 *
 * Kept: `active`, `device`, `currentTrack` (broadcast over the air; dj-site's
 * greyscale member banner renders it), and the activation/deactivation
 * timestamps. Pure: returns a fresh object, never mutates the input.
 */
export function reduceStatusBelowDj(status: AutoDJStatus): AutoDJStatus {
  return {
    active: status.active,
    activatedAt: status.activatedAt,
    currentTrack: status.currentTrack,
    lastDeactivatedAt: status.lastDeactivatedAt,
    device: status.device,
  };
}

// Compile-time exhaustiveness tie (mirrors codec.ts's `_AssertInboundMatchesContract`):
// every `AutoDJStatus` field must be classified as kept-for-members or hidden. Add
// a field to the schema without listing it in the projection above and one of these
// unions and `tsc` fails here — so the redaction can never silently pass a new
// identity/internal field through to below-`dj` users.
type BelowDjKeptField = 'active' | 'activatedAt' | 'currentTrack' | 'lastDeactivatedAt' | 'device';
type BelowDjHiddenField = 'activatedBy' | 'lastDeactivatedBy' | 'showId';
type _AssertStatusFieldsClassified =
  Exclude<keyof AutoDJStatus, BelowDjKeptField | BelowDjHiddenField> extends never ? true : never;
const _statusFieldsClassifiedTie: _AssertStatusFieldsClassified = true;
void _statusFieldsClassifiedTie;

export function selectDeactivateResponse(state: ActivationState): AutoDJDeactivateResponse {
  const by = state.lastDeactivatedBy;
  return {
    active: false,
    deactivatedBy: by ? toSource(by) : { source: 'virtual_switch' },
    deactivatedAt: by?.at ?? '',
  };
}
