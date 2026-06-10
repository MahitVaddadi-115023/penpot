// compiler.types.d.ts — Ambient types for IDE hover; not compiled.
// Source of truth is compiler.mjs (pure ES module, no TS build step).

export type ShapeType = 'board' | 'group' | 'rectangle' | 'ellipse' | 'text';
export type BindingType = 'anchor';

export interface Shape {
  id: string;
  type: ShapeType;
  parent?: string | null;
  x: number;
  y: number;
  w?: number;
  h?: number;
  rotation?: number;
  opacity?: number;
  locked?: boolean;
  name?: string;
  meta?: Record<string, unknown>;
  props: Record<string, unknown>;
}

export interface Binding {
  id: string;
  type: BindingType;
  fromId: string;
  toId: string;
  props: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

export interface IR {
  v: 1;
  page: string;
  shapes: Shape[];
  bindings?: Binding[];
  anchored?: string[];
  tokens?: Record<string, string>;
  meta?: Record<string, unknown>;
}

export interface CanvasState {
  page: string;
  shapes: Shape[];
  bindings?: Binding[];
}

export type MutationOp = 'create' | 'update' | 'delete' | 'reparent';

export interface Mutation {
  op: MutationOp;
  shapeId: string;
  shapeType?: ShapeType;            // present on 'create'
  parent?: string | null;            // present on 'create' and 'reparent'
  fields?: Record<string, unknown>;  // present on 'create' and 'update'
}

export interface SkippedAnchor {
  path: string;                      // anchored path that was honored
  reason: 'anchored' | 'create-anchored';
  value: unknown;                    // value the IR wanted to write
}

export interface ValidationError {
  path: string;
  code: string;
  message: string;
  line?: number;
  col?: number;
  severity?: 'error' | 'warning';
}

export function parse(text: string): { ir: IR | null; errors: ValidationError[] };
export function format(ir: IR): string;
export function validate(ir: IR): ValidationError[];
export function compile(
  ir: IR,
  currentState: CanvasState | null
): { mutations: Mutation[]; skipped: SkippedAnchor[] };
export function decompile(state: CanvasState): IR;
export function applyMutations(state: CanvasState | null, mutations: Mutation[]): CanvasState;

export const SUPPORTED_SHAPES: readonly ShapeType[];
export const SUPPORTED_BINDINGS: readonly BindingType[];
