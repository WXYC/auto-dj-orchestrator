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

export function selectDeactivateResponse(state: ActivationState): AutoDJDeactivateResponse {
  const by = state.lastDeactivatedBy;
  return {
    active: false,
    deactivatedBy: by ? toSource(by) : { source: 'virtual_switch' },
    deactivatedAt: by?.at ?? '',
  };
}
