export type Locator =
  | { by: 'testId' | 'id' | 'name' | 'label' | 'placeholder' | 'text'; value: string }
  | { by: 'role'; role: 'button' | 'link' | 'checkbox' | 'radio'; value: string }
  | { by: 'css'; value: string };

export type Checkpoint = {
  path: string;
  title: string;
  headings: string[];
};

export type Step = {
  type: 'click' | 'fill' | 'select' | 'press' | 'checkText';
  locator?: Locator;
  label?: string;
  value?: string;
  env?: string;
  text?: string;
  after?: Checkpoint;
};

export type Flow = {
  version: 1;
  id: string;
  name: string;
  startUrl: string;
  createdAt: string;
  steps: Step[];
};

export type StepResult = {
  index: number;
  status: 'pass' | 'fail';
  message: string;
  actual?: Checkpoint;
};

export type RunResult = {
  flowId: string;
  name: string;
  status: 'pass' | 'fail';
  durationMs: number;
  finishedAt: string;
  steps: StepResult[];
  errors: string[];
  screenshot?: string;
};
// Kofu
