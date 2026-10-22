export interface RuntimeTaskCompletedEvent {
  type: 'runtime';
  kind: 'task_completed';
  chatId: string;
  receivedAtMs: number;
  timestampSec: number;
  utcOffsetMin: number;
  taskId: number;
  taskType: string;
  intention?: string;
  finalSummary: string;
  hasFullOutput: boolean;
}

export interface RuntimePluginEvent {
  type: 'runtime';
  kind: 'plugin_event';
  chatId: string;
  receivedAtMs: number;
  timestampSec: number;
  utcOffsetMin: number;
  plugin: string;
  text: string;
}

// Extensible: future runtime event kinds can be added here.
export type RuntimeEvent = RuntimeTaskCompletedEvent | RuntimePluginEvent;

// Stored in the events table's runtimeData JSON column.
export interface RuntimeTaskCompletedData {
  kind: 'task_completed';
  taskId: number;
  taskType: string;
  intention?: string;
  finalSummary: string;
  hasFullOutput: boolean;
}

export interface RuntimePluginEventData {
  kind: 'plugin_event';
  plugin: string;
  text: string;
}

export type RuntimeEventData = RuntimeTaskCompletedData | RuntimePluginEventData;
