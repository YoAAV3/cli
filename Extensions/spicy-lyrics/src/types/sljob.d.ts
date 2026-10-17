export type Job = {
  handler: string;
  args?: any;
};

export type JobResponse = {
  handler: string;
  args?: any;
  result: JobResult;
};

export type JobResult = {
  responseData: any;
  status: number;
  type: string;
};

export interface JobResultGetter {
  get(handler: string): JobResult | undefined;
}

export function SendJob(jobs: Job[], headers?: Record<string, string>): Promise<JobResultGetter>;

export type SlJobConfig = {
  api_url: string;
};

declare module "*sljob.dist.js" {
  const Jobs: any;
  export default Jobs;
}
