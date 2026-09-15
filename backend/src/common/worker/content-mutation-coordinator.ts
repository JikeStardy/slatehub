import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import { KeyedPromiseQueue } from './keyed-promise-queue';

@Injectable()
export class ContentMutationCoordinator {
  private static readonly fallback = new ContentMutationCoordinator();
  private readonly queue = new KeyedPromiseQueue();
  private readonly heldContentIds = new AsyncLocalStorage<Set<string>>();

  static default(): ContentMutationCoordinator {
    return ContentMutationCoordinator.fallback;
  }

  run<T>(
    contentId: string,
    fn: () => Promise<T>,
    opts: { continueAfterFailure?: boolean } = {}
  ): Promise<T> {
    const held = this.heldContentIds.getStore();
    if (held?.has(contentId)) return fn();

    return this.queue.run(
      contentId,
      () => {
        const nextHeld = new Set(held ?? []);
        nextHeld.add(contentId);
        return this.heldContentIds.run(nextHeld, fn);
      },
      opts
    );
  }
}
