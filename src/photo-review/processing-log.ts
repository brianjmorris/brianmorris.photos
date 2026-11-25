export interface DateFieldResult {
  tag: string;
  before: string | null;
  after: string | null;
}

export interface ProcessingEvent {
  time: number;
  message: string;
  dates?: DateFieldResult[];
}
