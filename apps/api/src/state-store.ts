export { FileStateStore } from "./file-state-store.js";

export interface StateStore<State> {
  read(): State;
  update<Result>(change: (draft: State) => Result): Result;
}

export class MemoryStateStore<State> implements StateStore<State> {
  private state: State;

  constructor(initial: State) {
    this.state = structuredClone(initial);
  }

  read(): State {
    return structuredClone(this.state);
  }

  update<Result>(change: (draft: State) => Result): Result {
    const draft = this.read();
    const result = change(draft);
    this.state = structuredClone(draft);
    return result;
  }
}
