export interface ProgressUpdate {
  message?: string;
  increment?: number;
}

export interface ProgressReporter {
  report(update: ProgressUpdate): void;
}

export const noopProgress: ProgressReporter = {
  report() {},
};
