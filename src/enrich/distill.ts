export function distill(args: {
  title: string; shortSummary: string | null; status: string | null;
  platform: string[]; strategicGoal: string[]; body: string;
  threshold: number; sectionHeadChars: number;
}): string {
  const header =
    `Title: ${args.title}\n` +
    `Short summary: ${args.shortSummary ?? '(none)'}\n` +
    `Status: ${args.status ?? '(none)'}\n` +
    `Platform: ${args.platform.join(', ') || '(none)'}\n` +
    `Strategic goal: ${args.strategicGoal.join(', ') || '(none)'}\n\n`;

  if (args.body.length <= args.threshold) {
    return header + args.body;
  }

  const lines = args.body.split('\n');
  const out: string[] = [];
  let underHeading = 0; // chars emitted since the last heading
  let sawHeading = false;
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      out.push(line);
      underHeading = 0;
      sawHeading = true;
    } else if (underHeading < args.sectionHeadChars && line.trim()) {
      const remaining = args.sectionHeadChars - underHeading;
      out.push(line.slice(0, remaining));
      underHeading += Math.min(line.length, remaining);
    }
  }
  // No headings at all: fall back to a single bounded excerpt of the body.
  const distilledBody = sawHeading ? out.join('\n') : args.body.slice(0, args.sectionHeadChars * 5);
  return header + distilledBody;
}
