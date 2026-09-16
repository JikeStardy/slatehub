import { z } from 'zod';
import registryData from './display-profiles.json' with { type: 'json' };

export const PixelFormat = z.enum(['mono1']);
export type PixelFormatT = z.infer<typeof PixelFormat>;

export const FrameCodec = z.enum(['raw_mono1_msb']);
export type FrameCodecT = z.infer<typeof FrameCodec>;

export const DisplayProfileEnvironment = z.enum(['production', 'development', 'test']);
export type DisplayProfileEnvironmentT = z.infer<typeof DisplayProfileEnvironment>;

export const BoardCapabilities = z.object({
  audio: z.boolean(),
  partial_refresh: z.boolean(),
});
type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends ReadonlyArray<infer U>
    ? ReadonlyArray<DeepReadonly<U>>
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export type BoardCapabilitiesT = DeepReadonly<z.infer<typeof BoardCapabilities>>;

export const BoardDefinition = z.object({
  id: z.string().min(1),
  display_profile_id: z.string().min(1),
  capabilities: BoardCapabilities,
});
export type BoardDefinitionT = DeepReadonly<z.infer<typeof BoardDefinition>>;

export const DisplayProfile = z.object({
  id: z.string().min(1),
  width: z.number().int().positive().multipleOf(8),
  height: z.number().int().positive(),
  pixel_format: PixelFormat,
  frame_codec: FrameCodec,
  availability: z.array(DisplayProfileEnvironment).min(1),
});
export type DisplayProfileT = DeepReadonly<z.infer<typeof DisplayProfile>>;

const DisplayProfileRegistry = z.object({
  boards: z.array(BoardDefinition).min(1),
  display_profiles: z.array(DisplayProfile).min(1),
});

const registry = deepFreeze(DisplayProfileRegistry.parse(registryData));
const boardsById = new Map(registry.boards.map((board) => [board.id, board]));
const profilesById = new Map(registry.display_profiles.map((profile) => [profile.id, profile]));

assertUniqueIds(registry.boards, 'board');
assertUniqueIds(registry.display_profiles, 'display profile');
for (const board of registry.boards) {
  if (!profilesById.has(board.display_profile_id)) {
    throw new Error(`board ${board.id} references an unknown display profile`);
  }
}

export const BOARD_DEFINITIONS: ReadonlyArray<BoardDefinitionT> = registry.boards;
export const DISPLAY_PROFILES: ReadonlyArray<DisplayProfileT> = registry.display_profiles;
export const DEFAULT_BOARD_ID = 'zectrix-note4';
export const DEFAULT_DISPLAY_PROFILE_ID = 'zectrix-note4-400x300-mono';

export const BoardId = z.string().refine((id) => boardsById.has(id), 'unknown board id');
export type BoardIdT = z.infer<typeof BoardId>;

export const DisplayProfileId = z
  .string()
  .refine((id) => profilesById.has(id), 'unknown display profile id');
export type DisplayProfileIdT = z.infer<typeof DisplayProfileId>;

export function getBoardDefinition(boardId: string): BoardDefinitionT {
  const board = boardsById.get(BoardId.parse(boardId));
  if (!board) throw new Error(`unknown board id: ${boardId}`);
  return board;
}

export function getDisplayProfile(profileId: string): DisplayProfileT {
  const profile = profilesById.get(DisplayProfileId.parse(profileId));
  if (!profile) throw new Error(`unknown display profile id: ${profileId}`);
  return profile;
}

export function displayProfilesForEnvironment(
  environment: DisplayProfileEnvironmentT
): ReadonlyArray<DisplayProfileT> {
  return DISPLAY_PROFILES.filter((profile) => profile.availability.includes(environment));
}

export function frameByteLength(
  profile: Pick<DisplayProfileT, 'width' | 'height' | 'pixel_format'>
): number {
  switch (profile.pixel_format) {
    case 'mono1':
      return (profile.width * profile.height) / 8;
  }
}

export const FrameDescriptor = z
  .object({
    profile_id: DisplayProfileId,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    pixel_format: PixelFormat,
    frame_codec: FrameCodec,
    byte_length: z.number().int().nonnegative(),
  })
  .superRefine((descriptor, ctx) => {
    const profile = profilesById.get(descriptor.profile_id);
    if (!profile) return;
    if (
      descriptor.width !== profile.width ||
      descriptor.height !== profile.height ||
      descriptor.pixel_format !== profile.pixel_format ||
      descriptor.frame_codec !== profile.frame_codec ||
      descriptor.byte_length !== frameByteLength(profile)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'frame descriptor does not match its display profile',
      });
    }
  });
export type FrameDescriptorT = z.infer<typeof FrameDescriptor>;

export function frameDescriptorForProfile(profileId: string): FrameDescriptorT {
  const profile = getDisplayProfile(profileId);
  return {
    profile_id: profile.id,
    width: profile.width,
    height: profile.height,
    pixel_format: profile.pixel_format,
    frame_codec: profile.frame_codec,
    byte_length: frameByteLength(profile),
  };
}

function assertUniqueIds(values: ReadonlyArray<{ id: string }>, kind: string): void {
  const ids = new Set(values.map((value) => value.id));
  if (ids.size !== values.length)
    throw new Error(`duplicate ${kind} id in display profile registry`);
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (!value || typeof value !== 'object') return value as DeepReadonly<T>;

  for (const property of Reflect.ownKeys(value)) {
    const child = (value as Record<PropertyKey, unknown>)[property];
    if (child && typeof child === 'object' && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }

  return Object.freeze(value) as DeepReadonly<T>;
}
