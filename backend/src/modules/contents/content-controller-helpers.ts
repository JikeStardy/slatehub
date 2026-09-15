import type { FastifyReply } from 'fastify';
import { DisplayProfileId } from 'shared';
import { ValidationError } from '../../common/errors';
import type { DeviceContext, WebUserContext } from '../../common/nest/auth-context';

export function abortSignalForReply(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.once('close', () => {
    if (!reply.raw.writableEnded) controller.abort();
  });
  return controller.signal;
}

export function contentAuthScope(
  user: WebUserContext | undefined,
  device: DeviceContext | undefined,
  displayProfileId?: unknown
): { userId?: string; deviceId?: string; displayProfileId?: string } {
  return {
    userId: user?.userId,
    deviceId: device?.deviceId,
    displayProfileId: displayProfileIdFromQuery(displayProfileId),
  };
}

export function displayProfileIdFromQuery(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new ValidationError('display_profile_id 必须是字符串');
  }
  const parsed = DisplayProfileId.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError('未知 display_profile_id', { display_profile_id: value });
  }
  return parsed.data;
}
