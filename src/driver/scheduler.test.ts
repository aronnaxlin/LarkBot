import { Format, initLogger, LogLevel, useLogger } from '@guiiai/logg';
import type { Logger } from '@guiiai/logg';
import { signal } from 'alien-signals';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createReplyScheduler } from './scheduler';
import type { WakeupOutcome, WakeupRetry } from './scheduler';
import type { RenderedContext } from '../rendering/types';

initLogger(LogLevel.Error, Format.Pretty);
const log = useLogger('scheduler-test');

const segment = (receivedAtMs: number, senderId: string): RenderedContext[number] => ({
  receivedAtMs,
  senderId,
  content: [{ type: 'text', text: senderId }],
});

const DONE: WakeupOutcome = { kind: 'done' };
const FAILURE: WakeupOutcome = { kind: 'failure' };
const TRANSIENT: WakeupOutcome = { kind: 'transient-failure' };

const debounce = { initialDelayMs: 100, typingExtendMs: 100, maxDelayMs: 500 };

const makeScheduler = (overrides: Partial<Parameters<typeof createReplyScheduler>[0]> = {}) => {
  const context = signal<RenderedContext>([segment(1000, 'a')]);
  const lastProcessedMs = signal(0);
  const failedContext = signal<RenderedContext | null>(null);
  const execute = vi.fn(async (_context: RenderedContext, _retry?: WakeupRetry): Promise<WakeupOutcome> => DONE);
  const scheduler = createReplyScheduler({
    chatId: 'chat',
    debounce,
    context,
    lastProcessedMs,
    lastTurnInterrupted: signal(false),
    failedContext,
    execute,
    onDebounceStateChange: () => {},
    retryDelaysMs: [1000, 3000],
    log,
    ...overrides,
  });
  return { scheduler, context, lastProcessedMs, failedContext, execute };
};

describe('createReplyScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not extend the trigger sender deadline for another sender', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { scheduler, context, execute } = makeScheduler();

    vi.setSystemTime(1050);
    context([segment(1000, 'a'), segment(1050, 'b')]);
    await vi.advanceTimersByTimeAsync(50);
    expect(execute).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it('extends for typing but never past the hard cap', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { scheduler, execute } = makeScheduler({
      debounce: { initialDelayMs: 100, typingExtendMs: 300, maxDelayMs: 250 },
    });

    vi.setSystemTime(1050);
    scheduler.notifyTyping();
    await vi.advanceTimersByTimeAsync(199);
    expect(execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(execute).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it('does not rerun a context after a permanent failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { scheduler, context, failedContext, execute } = makeScheduler();
    execute.mockResolvedValue(FAILURE);

    await vi.advanceTimersByTimeAsync(100);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(failedContext()).toBe(context());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execute).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it('retries a transient failure on the same context with backoff, then gives up', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { scheduler, context, lastProcessedMs, failedContext, execute } = makeScheduler();
    // The probe ran and advanced the watermark before primary failed, so the
    // context alone no longer needs a reply; the retry must still fire.
    execute.mockImplementation(async () => {
      lastProcessedMs(Date.now());
      return TRANSIENT;
    });
    const initial = context();

    await vi.advanceTimersByTimeAsync(100);
    expect(execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]![0]).toBe(initial);
    expect(execute.mock.calls[0]![1]).toBeUndefined();
    expect(execute.mock.calls[1]![1]).toEqual({ probeActivation: undefined });
    expect(failedContext()).toBeNull();
    await vi.advanceTimersByTimeAsync(3000);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(failedContext()).toBe(initial);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execute).toHaveBeenCalledTimes(3);
    scheduler.dispose();
  });

  it('stops retrying once an attempt succeeds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { scheduler, lastProcessedMs, failedContext, execute } = makeScheduler();
    execute.mockResolvedValueOnce(TRANSIENT).mockImplementation(async () => {
      lastProcessedMs(Date.now());
      return DONE;
    });

    await vi.advanceTimersByTimeAsync(1100);
    expect(execute).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(failedContext()).toBeNull();
    scheduler.dispose();
  });

  it('lets new input during the backoff supersede the retry with a debounced fresh wake-up', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { scheduler, context, lastProcessedMs, execute } = makeScheduler({ retryDelaysMs: [10_000] });
    execute.mockImplementationOnce(async () => TRANSIENT).mockImplementation(async () => {
      lastProcessedMs(Date.now());
      return DONE;
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(execute).toHaveBeenCalledTimes(1);
    vi.setSystemTime(2000);
    const newer = [segment(1000, 'a'), segment(2000, 'b')];
    context(newer);
    await vi.advanceTimersByTimeAsync(100);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]![0]).toBe(newer);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(execute).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it('lets new external input supersede a primary-failure retry without carrying its activation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const debug = vi.fn();
    const stubLog = { withFields: () => ({ debug, log: () => {} }) } as unknown as Logger;
    const { scheduler, context, lastProcessedMs, execute } = makeScheduler({ retryDelaysMs: [10_000], log: stubLog });
    execute.mockImplementationOnce(async () => {
      lastProcessedMs(Date.now());
      return { kind: 'transient-failure', probeActivation: { reason: 'asked' } };
    }).mockImplementation(async () => {
      lastProcessedMs(Date.now());
      return DONE;
    });

    await vi.advanceTimersByTimeAsync(100);
    vi.setSystemTime(2000);
    const newer = [segment(1000, 'a'), segment(2000, 'b')];
    context(newer);
    expect(debug).toHaveBeenCalledWith('Pending retry superseded by new input');
    await vi.advanceTimersByTimeAsync(99);
    expect(execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]![0]).toBe(newer);
    expect(execute.mock.calls[1]![1]).toBeUndefined();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(debug).toHaveBeenCalledOnce();
    scheduler.dispose();
  });

  it('passes a probe activation from the failed attempt into the retry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { scheduler, lastProcessedMs, execute } = makeScheduler();
    execute.mockImplementationOnce(async () => {
      lastProcessedMs(Date.now());
      return { kind: 'transient-failure', probeActivation: { reason: 'asked directly' } };
    }).mockResolvedValue(DONE);

    await vi.advanceTimersByTimeAsync(1100);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]![1]).toEqual({ probeActivation: { reason: 'asked directly' } });
    scheduler.dispose();
  });

  it.each([
    ['a same-content replacement array (compaction)', () => [segment(1000, 'a')]],
    ['an in-place edit', () => [{ ...segment(1000, 'a'), content: [{ type: 'text' as const, text: 'edited' }] }]],
    ['a self-sent event', () => [segment(1000, 'a'), { ...segment(1050, 'bot'), isMyself: true }]],
  ])('keeps the retry live across %s and runs it against the current context', async (_name, replacement) => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { scheduler, context, lastProcessedMs, failedContext, execute } = makeScheduler();
    execute.mockImplementationOnce(async () => {
      // Probe advanced the watermark before primary failed.
      lastProcessedMs(Date.now());
      return { kind: 'transient-failure', probeActivation: { reason: 'asked' } };
    }).mockResolvedValue(DONE);

    await vi.advanceTimersByTimeAsync(100);
    expect(execute).toHaveBeenCalledTimes(1);
    const replaced = replacement();
    context(replaced);
    await vi.advanceTimersByTimeAsync(999);
    expect(execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]![0]).toBe(replaced);
    expect(execute.mock.calls[1]![1]).toEqual({ probeActivation: { reason: 'asked' } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(failedContext()).toBeNull();
    scheduler.dispose();
  });

  it('does not let typing during the backoff postpone or duplicate the retry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { scheduler, lastProcessedMs, execute } = makeScheduler();
    execute.mockImplementationOnce(async () => {
      lastProcessedMs(Date.now());
      return TRANSIENT;
    }).mockResolvedValue(DONE);

    await vi.advanceTimersByTimeAsync(100);
    for (let i = 0; i < 9; i++) {
      await vi.advanceTimersByTimeAsync(100);
      scheduler.notifyTyping();
    }
    await vi.advanceTimersByTimeAsync(99);
    expect(execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(execute).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execute).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it('handles new input that arrives while a retry attempt is running', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { scheduler, context, lastProcessedMs, execute } = makeScheduler();
    let releaseRetry: (outcome: WakeupOutcome) => void = () => {};
    execute
      .mockImplementationOnce(async () => {
        lastProcessedMs(Date.now());
        return TRANSIENT;
      })
      .mockImplementationOnce(() => new Promise<WakeupOutcome>(resolve => { releaseRetry = resolve; }))
      .mockImplementation(async () => {
        lastProcessedMs(Date.now());
        return DONE;
      });

    await vi.advanceTimersByTimeAsync(1100);
    expect(execute).toHaveBeenCalledTimes(2);
    const newer = [segment(1000, 'a'), segment(Date.now(), 'b')];
    context(newer);
    // Calls are serialized: nothing starts while the retry attempt runs.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(execute).toHaveBeenCalledTimes(2);

    // The running attempt fails again; its retry is stale against the new
    // context, so exactly one fresh, debounced wake-up runs for the new input.
    releaseRetry(TRANSIENT);
    await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[2]![0]).toBe(newer);
    expect(execute.mock.calls[2]![1]).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execute).toHaveBeenCalledTimes(3);
    scheduler.dispose();
  });

  it('cancels a pending retry on dispose', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { scheduler, execute } = makeScheduler();
    execute.mockResolvedValue(TRANSIENT);

    await vi.advanceTimersByTimeAsync(100);
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
