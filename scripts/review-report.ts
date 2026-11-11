export type ReviewReportAxis = "spec" | "standards";
export type CollectedReviewVerdict = "PASS" | "CHANGES_REQUESTED";

export const REVIEW_REPORT_CONTRACT = "boardroom-review-report/v1";
const SECTIONS = ["## Evidence", "## Risks and gaps", "## Checks"] as const;

/** 只验证输出结构，不能证明内容正确、证据充分或模型真实执行。 */
export function validateReviewReport(output: string, axis: ReviewReportAxis): {
  reportComplete: boolean; verdict: CollectedReviewVerdict | null; errors: string[];
} {
  const text = output.replace(/\r\n/g, "\n").trim();
  const lines = text.split("\n");
  const errors: string[] = [];
  if (Buffer.byteLength(output, "utf8") > 64 * 1024) errors.push("report_too_large");

  const metadata = lines.filter(line => line.trim());
  const axisLines = lines.filter(line => /^Review-Axis\s*:/i.test(line));
  if (metadata[0] !== `Review-Axis: ${axis}` || axisLines.length !== 1) errors.push("missing_or_invalid_axis");
  const verdictLines = lines.filter(line => /^(?:Verdict|结论)\s*[:：]/i.test(line));
  const match = metadata[1]?.match(/^Verdict: (PASS|CHANGES_REQUESTED)$/);
  const verdict = match?.[1] as CollectedReviewVerdict | undefined;
  if (!verdict || verdictLines.length !== 1) errors.push("missing_or_ambiguous_verdict");

  const endMarker = `<!-- review-report-complete:${axis} -->`;
  const markers = lines.filter(line => line.includes("review-report-complete:"));
  if (lines.at(-1) !== endMarker || markers.length !== 1) errors.push("missing_or_invalid_end_marker");
  const headings = lines.flatMap((line, index) => /^##\s/.test(line) ? [{ line, index }] : []);
  if (headings.length !== SECTIONS.length || SECTIONS.some((section, index) => headings[index]?.line !== section)) {
    errors.push("missing_or_invalid_sections");
  } else {
    for (let index = 0; index < headings.length; index++) {
      const start = headings[index]!.index + 1;
      const end = headings[index + 1]?.index ?? lines.length - 1;
      const body = lines.slice(start, end).join("\n").replace(/<!--[\s\S]*?-->/g, "").trim();
      // 不靠字符数判断完整性；纯标记、空标题和未替换的模板占位不能充当章节正文。
      const content = body.replace(/^#{1,6} .*$/gm, "").replace(/<[^>]*>/g, "").trim();
      if (!/[\p{L}\p{N}]/u.test(content) || /^(?:[-*]\s*)?(?:TODO|TBD|待填写|填写内容)[.。…\s]*$/i.test(content)) {
        errors.push(`empty_section:${SECTIONS[index]}`);
      }
    }
  }
  return { reportComplete: errors.length === 0, verdict: errors.length === 0 ? verdict! : null, errors };
}

export function reviewReportInstructions(axis: ReviewReportAxis): string {
  return `报告格式 ${REVIEW_REPORT_CONTRACT}：使用以下确切字段、章节名与顺序，不要包在代码围栏中，不要输出模板占位。
第一行必须为 Review-Axis: ${axis}；第二个非空行必须是唯一的 Verdict: PASS 或 Verdict: CHANGES_REQUESTED（二选一，不写两行或其他结论字段）。
接着依次输出三个二级标题，每节必须有实际正文，可使用三级小标题：
## Evidence
逐项列出本轴发现或通过依据，标明任务要求/仓库规范及具体文件、位置；需要修改时说明影响与修正要求。
## Risks and gaps
列出剩余风险与未覆盖范围；没有已知事项时明确写出此事实，不能省略章节。
## Checks
区分实际执行的命令和结果、只读源码核对、未执行检查及原因，不能把未执行写成通过。
最后一个非空行必须且只能出现一次：${`<!-- review-report-complete:${axis} -->`}
只有写完全部内容后才输出结束标记。结构完整只表示可供 reviewer 核对，不表示结论正确或平台已通过。`;
}
