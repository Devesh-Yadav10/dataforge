import { randomUUID } from 'node:crypto';

export type OperationType = 'stt' | 'llm' | 'tool' | 'tts';

export type TrackerEventType =
  | 'generation_started'
  | 'interruption_detected'
  | 'generation_invalidated'
  | 'operation_started'
  | 'operation_completed'
  | 'operation_failed'
  | 'cancellation_requested'
  | 'operation_cancelled'
  | 'operation_discarded';

export interface StructuredEvent {
  timestamp: number;
  session_id: string;
  generation_id: number;
  operation_id: string;
  operation_type: OperationType;
  event_type: TrackerEventType;
  details?: Record<string, unknown>;
}

export interface Operation {
  readonly session_id: string;
  readonly generation_id: number;
  readonly operation_id: string;
  readonly operation_type: OperationType;
  readonly started_at: number;
  readonly abortController: AbortController;
  completed_at?: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'discarded';
  discard_reason?: string;
  cancellation_requested?: boolean;
}

export class GenerationTracker {
  private readonly _sessionId: string;
  private _currentGeneration: number;
  private _operationCounter: number = 0;
  private readonly _activeOperations: Map<string, Operation> = new Map();
  private readonly _generationControllers: Map<number, AbortController> = new Map();
  private readonly _eventListeners: Array<(event: StructuredEvent) => void> = [];

  constructor(sessionId?: string, initialGeneration: number = 1) {
    this._sessionId = sessionId || `session-${randomUUID().slice(0, 8)}`;
    this._currentGeneration = initialGeneration;
    this._generationControllers.set(initialGeneration, new AbortController());
  }

  get sessionId(): string {
    return this._sessionId;
  }

  get currentGeneration(): number {
    return this._currentGeneration;
  }

  public getGenerationSignal(generationId?: number): AbortSignal {
    const genId = generationId ?? this._currentGeneration;
    let controller = this._generationControllers.get(genId);
    if (!controller) {
      controller = new AbortController();
      this._generationControllers.set(genId, controller);
    }
    return controller.signal;
  }

  public getOperation(operationId: string): Operation | undefined {
    return this._activeOperations.get(operationId);
  }

  public hasRunningOperations(generationId?: number): boolean {
    for (const op of this._activeOperations.values()) {
      if (op.status === 'running') {
        if (generationId === undefined || op.generation_id === generationId) {
          return true;
        }
      }
    }
    return false;
  }

  public hasRunningOperationType(type: OperationType, generationId?: number): boolean {
    for (const op of this._activeOperations.values()) {
      if (op.status === 'running' && op.operation_type === type) {
        if (generationId === undefined || op.generation_id === generationId) {
          return true;
        }
      }
    }
    return false;
  }

  public nextGeneration(reason: string = 'new_turn'): number {
    const oldGen = this._currentGeneration;
    const newGen = oldGen + 1;
    this._currentGeneration = newGen;

    // Abort old generation controller & operations
    const oldController = this._generationControllers.get(oldGen);
    if (oldController && !oldController.signal.aborted) {
      try { oldController.abort(reason); } catch (e) {}
    }
    this._generationControllers.delete(oldGen);
    this.abortGeneration(oldGen, reason);

    // Initialize new generation controller
    this._generationControllers.set(newGen, new AbortController());

    this.emitEvent({
      timestamp: Date.now(),
      session_id: this._sessionId,
      generation_id: this._currentGeneration,
      operation_id: 'system',
      operation_type: 'stt',
      event_type: 'generation_started',
      details: { new_generation: this._currentGeneration, reason },
    });
    return this._currentGeneration;
  }

  /**
   * Primary interruption handler:
   * 1. Capture old generation
   * 2. Atomically increment generation FIRST (invalidates old generation)
   * 3. Abort all running operations and generation controller belonging to old generation
   * 4. Emit structured events
   */
  public invalidateCurrentGeneration(reason: string = 'user_interruption'): {
    oldGeneration: number;
    newGeneration: number;
    abortedOperationsCount: number;
  } {
    const oldGen = this._currentGeneration;
    // Step 1 & 2: Monotonically increment FIRST so old generation is immediately stale
    const newGen = this._currentGeneration + 1;
    this._currentGeneration = newGen;

    const oldController = this._generationControllers.get(oldGen);
    if (oldController && !oldController.signal.aborted) {
      try { oldController.abort(reason); } catch (e) {}
    }
    this._generationControllers.delete(oldGen);

    this.emitEvent({
      timestamp: Date.now(),
      session_id: this._sessionId,
      generation_id: oldGen,
      operation_id: 'system',
      operation_type: 'stt',
      event_type: 'interruption_detected',
      details: {
        interrupted_generation: oldGen,
        new_generation: newGen,
        reason,
      },
    });

    this.emitEvent({
      timestamp: Date.now(),
      session_id: this._sessionId,
      generation_id: oldGen,
      operation_id: 'system',
      operation_type: 'stt',
      event_type: 'generation_invalidated',
      details: {
        invalidated_generation: oldGen,
        active_generation: newGen,
        reason,
      },
    });

    // Step 3: Abort running operations belonging to old generation
    const abortedCount = this.abortGeneration(oldGen, reason);

    // Initialize new generation controller
    this._generationControllers.set(newGen, new AbortController());

    // Step 4: Emit new generation started
    this.emitEvent({
      timestamp: Date.now(),
      session_id: this._sessionId,
      generation_id: newGen,
      operation_id: 'system',
      operation_type: 'stt',
      event_type: 'generation_started',
      details: {
        new_generation: newGen,
        reason: 'interruption_recovery',
      },
    });

    return {
      oldGeneration: oldGen,
      newGeneration: newGen,
      abortedOperationsCount: abortedCount,
    };
  }

  public abortGeneration(generationId: number, reason: string = 'STALE_GENERATION'): number {
    let count = 0;
    const controller = this._generationControllers.get(generationId);
    if (controller && !controller.signal.aborted) {
      try { controller.abort(reason); } catch (e) {}
    }

    for (const op of this._activeOperations.values()) {
      if (op.generation_id === generationId && op.status === 'running') {
        op.cancellation_requested = true;
        this.emitEvent({
          timestamp: Date.now(),
          session_id: op.session_id,
          generation_id: op.generation_id,
          operation_id: op.operation_id,
          operation_type: op.operation_type,
          event_type: 'cancellation_requested',
          details: { reason, generation_id: generationId },
        });

        try {
          op.abortController.abort(reason);
        } catch (err) {
          console.error(`Error aborting operation ${op.operation_id}:`, err);
        }
        count += 1;
      }
    }
    return count;
  }

  public startOperation(type: OperationType, generationId?: number): Operation {
    this._operationCounter += 1;
    const opId = `op-${this._operationCounter}`;
    const genId = generationId ?? this._currentGeneration;

    const operation: Operation = {
      session_id: this._sessionId,
      generation_id: genId,
      operation_id: opId,
      operation_type: type,
      started_at: Date.now(),
      abortController: new AbortController(),
      status: 'running',
    };

    const genSignal = this.getGenerationSignal(genId);
    if (genSignal.aborted) {
      try { operation.abortController.abort(genSignal.reason || 'STALE_GENERATION'); } catch (e) {}
    } else {
      genSignal.addEventListener('abort', () => {
        if (!operation.abortController.signal.aborted) {
          try { operation.abortController.abort(genSignal.reason || 'STALE_GENERATION'); } catch (e) {}
        }
      }, { once: true });
    }

    this._activeOperations.set(opId, operation);

    this.emitEvent({
      timestamp: operation.started_at,
      session_id: this._sessionId,
      generation_id: genId,
      operation_id: opId,
      operation_type: type,
      event_type: 'operation_started',
    });

    return operation;
  }

  public isCurrent(operationOrGeneration: Operation | number): boolean {
    const genId =
      typeof operationOrGeneration === 'number'
        ? operationOrGeneration
        : operationOrGeneration.generation_id;
    return genId === this._currentGeneration;
  }

  public completeOperation(operation: Operation, details?: Record<string, unknown>): boolean {
    const current = this.isCurrent(operation);
    operation.completed_at = Date.now();

    if (!current) {
      this.recordDiscard(operation, 'STALE_GENERATION', details);
      return false;
    }

    operation.status = 'completed';
    this._activeOperations.delete(operation.operation_id);

    this.emitEvent({
      timestamp: operation.completed_at,
      session_id: operation.session_id,
      generation_id: operation.generation_id,
      operation_id: operation.operation_id,
      operation_type: operation.operation_type,
      event_type: 'operation_completed',
      details,
    });

    return true;
  }

  public recordCancellation(operation: Operation, details?: Record<string, unknown>): void {
    operation.status = 'cancelled';
    operation.completed_at = Date.now();
    this._activeOperations.delete(operation.operation_id);

    this.emitEvent({
      timestamp: Date.now(),
      session_id: operation.session_id,
      generation_id: operation.generation_id,
      operation_id: operation.operation_id,
      operation_type: operation.operation_type,
      event_type: 'operation_cancelled',
      details: {
        current_generation: this._currentGeneration,
        operation_generation: operation.generation_id,
        ...details,
      },
    });
  }

  public recordFailure(
    operation: Operation,
    reason: string = 'OPERATION_FAILED',
    details?: Record<string, unknown>
  ): void {
    operation.status = 'failed';
    operation.completed_at = Date.now();
    operation.discard_reason = reason;
    this._activeOperations.delete(operation.operation_id);

    this.emitEvent({
      timestamp: Date.now(),
      session_id: operation.session_id,
      generation_id: operation.generation_id,
      operation_id: operation.operation_id,
      operation_type: operation.operation_type,
      event_type: 'operation_failed',
      details: {
        reason,
        current_generation: this._currentGeneration,
        operation_generation: operation.generation_id,
        ...details,
      },
    });
  }

  public recordDiscard(
    operation: Operation,
    reason: string = 'STALE_GENERATION',
    details?: Record<string, unknown>
  ): void {
    operation.status = 'discarded';
    operation.completed_at = Date.now();
    operation.discard_reason = reason;
    this._activeOperations.delete(operation.operation_id);

    this.emitEvent({
      timestamp: Date.now(),
      session_id: operation.session_id,
      generation_id: operation.generation_id,
      operation_id: operation.operation_id,
      operation_type: operation.operation_type,
      event_type: 'operation_discarded',
      details: {
        reason,
        current_generation: this._currentGeneration,
        operation_generation: operation.generation_id,
        cancellation_requested: operation.cancellation_requested ?? false,
        cancellation_result: operation.cancellation_requested
          ? 'completed_after_abort'
          : 'not_requested',
        ...details,
      },
    });
  }

  public addEventListener(listener: (event: StructuredEvent) => void): () => void {
    this._eventListeners.push(listener);
    return () => {
      const idx = this._eventListeners.indexOf(listener);
      if (idx !== -1) {
        this._eventListeners.splice(idx, 1);
      }
    };
  }

  private emitEvent(event: StructuredEvent): void {
    for (const listener of this._eventListeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('Error in tracker event listener:', err);
      }
    }
  }
}
