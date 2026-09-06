"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GenerationTracker = void 0;
const node_crypto_1 = require("node:crypto");
class GenerationTracker {
    constructor(sessionId, initialGeneration = 1) {
        this._operationCounter = 0;
        this._activeOperations = new Map();
        this._eventListeners = [];
        this._sessionId = sessionId || `session-${(0, node_crypto_1.randomUUID)().slice(0, 8)}`;
        this._currentGeneration = initialGeneration;
    }
    get sessionId() {
        return this._sessionId;
    }
    get currentGeneration() {
        return this._currentGeneration;
    }
    hasRunningOperations(generationId) {
        for (const op of this._activeOperations.values()) {
            if (op.status === 'running') {
                if (generationId === undefined || op.generation_id === generationId) {
                    return true;
                }
            }
        }
        return false;
    }
    nextGeneration(reason = 'new_turn') {
        this._currentGeneration += 1;
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
     * 3. Abort all running operations belonging to old generation
     * 4. Emit structured events
     */
    invalidateCurrentGeneration(reason = 'user_interruption') {
        const oldGen = this._currentGeneration;
        // Step 1 & 2: Monotonically increment FIRST so old generation is immediately stale
        const newGen = this._currentGeneration + 1;
        this._currentGeneration = newGen;
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
    abortGeneration(generationId, reason = 'STALE_GENERATION') {
        let count = 0;
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
                }
                catch (err) {
                    console.error(`Error aborting operation ${op.operation_id}:`, err);
                }
                count += 1;
            }
        }
        return count;
    }
    startOperation(type, generationId) {
        this._operationCounter += 1;
        const opId = `op-${this._operationCounter}`;
        const genId = generationId ?? this._currentGeneration;
        const operation = {
            session_id: this._sessionId,
            generation_id: genId,
            operation_id: opId,
            operation_type: type,
            started_at: Date.now(),
            abortController: new AbortController(),
            status: 'running',
        };
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
    isCurrent(operationOrGeneration) {
        const genId = typeof operationOrGeneration === 'number'
            ? operationOrGeneration
            : operationOrGeneration.generation_id;
        return genId === this._currentGeneration;
    }
    completeOperation(operation, details) {
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
    recordCancellation(operation, details) {
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
    recordDiscard(operation, reason = 'STALE_GENERATION', details) {
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
    addEventListener(listener) {
        this._eventListeners.push(listener);
        return () => {
            const idx = this._eventListeners.indexOf(listener);
            if (idx !== -1) {
                this._eventListeners.splice(idx, 1);
            }
        };
    }
    emitEvent(event) {
        for (const listener of this._eventListeners) {
            try {
                listener(event);
            }
            catch (err) {
                console.error('Error in tracker event listener:', err);
            }
        }
    }
}
exports.GenerationTracker = GenerationTracker;
