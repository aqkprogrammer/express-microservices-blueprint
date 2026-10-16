import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Correlation data that follows a unit of work (an HTTP request or a consumed
 * message) across async boundaries so logs and outgoing calls can carry it.
 */
export interface RequestContext {
  requestId: string;
  correlationId: string;
  /** ID of the message or request that directly caused this unit of work. */
  causationId?: string;
  userId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Mutates the active context (e.g. after authentication resolves the user). */
export function updateRequestContext(patch: Partial<RequestContext>): void {
  const store = storage.getStore();
  if (store) Object.assign(store, patch);
}
