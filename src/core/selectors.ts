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
 * full status"). Strips the identity/internal fields — `activatedBy`,
 * `lastDeactivatedBy`, and `showId` — from BOTH branches: `activatedBy` /
 * `showId` when active, `lastDeactivatedBy` when inactive (the deactivating
 * DJ's Better Auth `userId` would otherwise leak while auto-DJ is off).
 *
 * Everything else is kept, notably `currentTrack` — it is broadcast over the
 * air and dj-site's greyscale member banner renders it — along with `active`,
 * `device`, and the activation/deactivation timestamps. The reduced object omits
 * only optional fields, so it is still a valid `AutoDJStatus` (no `api.yaml`
 * change). Pure: returns a fresh object, never mutates the input.
 */
export function reduceStatusBelowDj(status: AutoDJStatus): AutoDJStatus {
  const { activatedBy, lastDeactivatedBy, showId, ...reduced } = status;
  return reduced;
}

export function selectDeactivateResponse(state: ActivationState): AutoDJDeactivateResponse {
  const by = state.lastDeactivatedBy;
  return {
    active: false,
    deactivatedBy: by ? toSource(by) : { source: 'virtual_switch' },
    deactivatedAt: by?.at ?? '',
  };
}
