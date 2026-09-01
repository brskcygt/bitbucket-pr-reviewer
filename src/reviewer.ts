import { query } from "@anthropic-ai/claude-agent-sdk";
import type { PRComment } from "./bitbucket";

// Claude'un döneceği inceleme yapısı (düz interface — SDK JSON parse eder)
export interface Review {
  summary: string;
  overall_score: "approve" | "needs_changes" | "comment_only";
  comments: Array<{
    type: "bug" | "security" | "performance" | "style" | "suggestion";
    severity: "critical" | "major" | "minor" | "info";
    file_path?: string;
    line_number?: number;
    body: string;
  }>;
}

const SYSTEM_PROMPT = `Sen kıdemli bir yazılım mühendisisin ve kod incelemesi yapıyorsun.
Görevin bir pull request'i inceleyerek gerçekten önemli sorunları bulmak.

Kurallar:
- En fazla 8 yorum yap, sadece önemli olanlara odaklan
- Her yorum body'si en fazla 2 cümle olsun
- Gereksiz nitpick'lerden kaçın
- Kodu türkçe veya ingilizce yorum yap (kodun diline göre karar ver)

ÇIKTI FORMATI: Yalnızca aşağıdaki yapıda geçerli bir JSON nesnesi döndür, başka hiçbir şey ekleme:
{"summary":"...","overall_score":"approve","comments":[{"type":"bug","severity":"major","file_path":"src/x.ts","line_number":10,"body":"..."}]}

overall_score değerleri: approve | needs_changes | comment_only
type değerleri: bug | security | performance | style | suggestion
severity değerleri: critical | major | minor | info`;

export async function reviewPR(
  prTitle: string,
  prDescription: string,
  sourceBranch: string,
  targetBranch: string,
  diff: string,
  fileContents: Record<string, string> = {}
): Promise<Review> {
  // Diff çok büyükse kırp
  const maxDiffLength = 30_000;
  const truncatedDiff =
    diff.length > maxDiffLength
      ? diff.slice(0, maxDiffLength) + "\n\n[... diff kısaltıldı, çok büyük ...]"
      : diff;

  const fileSection = Object.entries(fileContents)
    .map(([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``)
    .join("\n\n");

  const prompt = `${SYSTEM_PROMPT}

## Pull Request Bilgileri
- **Başlık:** ${prTitle}
- **Açıklama:** ${prDescription || "(açıklama yok)"}
- **Kaynak Dal:** ${sourceBranch} → **Hedef Dal:** ${targetBranch}

## Değiştirilen Dosyaların Tam İçeriği (PR sonrası)
${fileSection || "(dosya içeriği alınamadı)"}

## Diff (Değişiklikler)

\`\`\`diff
${truncatedDiff}
\`\`\`

Bu PR'ı incele.`;

  let result = "";
  for await (const message of query({ prompt, options: { tools: [] } })) {
    if (message.type === "result") result = (message as any).result as string;
  }

  const jsonMatch = result.match(/```(?:json)?\s*([\s\S]*?)```/) || result.match(/(\{[\s\S]*\})/);
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : result.trim();

  return JSON.parse(jsonStr) as Review;
}

export async function generateReply(prTitle: string, thread: PRComment[]): Promise<string> {
  const BOT_MARKER = "<!-- claude-pr-reviewer -->";

  const conversationLines = thread.map((c) => {
    const isBot = c.content.raw.includes(BOT_MARKER);
    const author = isBot ? "Claude (bot)" : c.user?.display_name ?? "Developer";
    const text = c.content.raw.replace(BOT_MARKER, "").trim();
    return `**${author}:** ${text}`;
  });

  const prompt = `Sen bir kod inceleme botusun. Bir PR'da developer ile konuşma yürütüyorsun.

PR Başlığı: ${prTitle}

Konuşma zinciri:
${conversationLines.join("\n\n")}

Son mesaja nazik, yapıcı ve kısa (en fazla 3 cümle) bir yanıt yaz. Yalnızca yanıt metnini döndür, başka hiçbir şey ekleme.`;

  let result = "";
  for await (const message of query({ prompt, options: { tools: [] } })) {
    if (message.type === "result") result = (message as any).result as string;
  }

  return result.trim();
}

export function formatSummaryComment(review: Review): string {
  const scoreEmoji: Record<string, string> = {
    approve: "✅",
    needs_changes: "🔄",
    comment_only: "💬",
  };

  const severityCount = review.comments.reduce(
    (acc, c) => {
      acc[c.severity] = (acc[c.severity] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  const lines = [
    `## ${scoreEmoji[review.overall_score]} Claude Kod İncelemesi`,
    "",
    review.summary,
    "",
    "### Özet",
    `| Önem | Sayı |`,
    `|------|------|`,
    ...(severityCount.critical ? [`| 🔴 Kritik | ${severityCount.critical} |`] : []),
    ...(severityCount.major ? [`| 🟠 Önemli | ${severityCount.major} |`] : []),
    ...(severityCount.minor ? [`| 🟡 Küçük | ${severityCount.minor} |`] : []),
    ...(severityCount.info ? [`| 🔵 Bilgi | ${severityCount.info} |`] : []),
    "",
    "*Bu inceleme Claude AI tarafından otomatik olarak yapılmıştır.*",
  ];

  return lines.join("\n");
}
