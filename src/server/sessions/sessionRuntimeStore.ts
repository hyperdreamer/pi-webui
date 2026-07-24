export interface ActiveSession<TRuntime> {
  runtime: TRuntime;
  unsubscribe: () => void;
}
