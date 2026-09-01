import "dotenv/config";
import { BitbucketClient, PullRequest } from "./bitbucket";
import { reviewPR, formatSummaryComment, generateReply } from "./reviewer";

const {
  BITBUCKET_USERNAME,
  BITBUCKET_TOKEN,
  BITBUCKET_WORKSPACE,
  BITBUCKET_REPO_SLUG,
  POLL_INTERVAL_MINUTES = "5",
} = process.env;

if (!BITBUCKET_USERNAME || !BITBUCKET_TOKEN || !BITBUCKET_WORKSPACE || !BITBUCKET_REPO_SLUG) {
  console.error("Eksik ortam değişkeni. .env dosyanızı kontrol edin.");
  process.exit(1);
}

const bitbucket = new BitbucketClient(
  BITBUCKET_WORKSPACE!,
  BITBUCKET_REPO_SLUG!,
  BITBUCKET_USERNAME!,
  BITBUCKET_TOKEN!
);

async function processPR(pr: PullRequest) {
  const alreadyReviewed = await bitbucket.isAlreadyReviewed(pr.id);

  if (!alreadyReviewed) {
    console.log(`[PR #${pr.id}] İnceleniyor: "${pr.title}"`);

    const diff = await bitbucket.getPRDiff(pr.id);
    if (!diff.trim()) {
      console.log(`[PR #${pr.id}] Diff boş, atlanıyor`);
      return;
    }

    const fileContents = await bitbucket.getPRFileContents(pr.source.commit.hash, diff);
    console.log(`[PR #${pr.id}] ${Object.keys(fileContents).length} dosya içeriği alındı`);

    const review = await reviewPR(
      pr.title,
      pr.description || "",
      pr.source.branch.name,
      pr.destination.branch.name,
      diff,
      fileContents
    );

    await bitbucket.postGeneralComment(pr.id, formatSummaryComment(review));

    const inlineComments = review.comments
      .filter((c) => c.file_path && c.line_number)
      .map((c) => ({
        body: formatInlineComment(c),
        filePath: c.file_path,
        lineNumber: c.line_number,
      }));

    if (inlineComments.length > 0) {
      await bitbucket.postReviewComments(pr.id, inlineComments as any);
    }

    console.log(`[PR #${pr.id}] Tamamlandı — karar: ${review.overall_score}, ${review.comments.length} yorum`);
  }

  const pendingReplies = await bitbucket.getPendingReplies(pr.id);
  if (pendingReplies.length > 0) {
    console.log(`[PR #${pr.id}] ${pendingReplies.length} yanıtsız yorum bulundu`);
    for (const { thread, replyTo } of pendingReplies) {
      const reply = await generateReply(pr.title, thread);
      await bitbucket.postReply(pr.id, replyTo.id, reply);
      console.log(`[PR #${pr.id}] "${replyTo.user?.display_name ?? "Developer"}" kullanıcısına yanıt verildi`);
    }
  }
}

async function runScan() {
  console.log(`[${new Date().toLocaleTimeString()}] Tarama başlıyor...`);
  try {
    const openPRs = await bitbucket.getOpenPRs();
    console.log(`${openPRs.length} açık PR bulundu`);
    for (const pr of openPRs) {
      await processPR(pr);
    }
  } catch (err: any) {
    console.error("Tarama hatası:", err.message);
  }
}

function formatInlineComment(comment: { type: string; severity: string; body: string }): string {
  const emoji: Record<string, string> = {
    bug: "🐛", security: "🔒", performance: "⚡", style: "🎨", suggestion: "💡",
  };
  const label: Record<string, string> = {
    critical: "**[KRİTİK]**", major: "**[ÖNEMLİ]**", minor: "[küçük]", info: "_[bilgi]_",
  };
  return `${emoji[comment.type] || "📝"} ${label[comment.severity] || ""} _${comment.type}_\n\n${comment.body}`;
}

const intervalMs = parseInt(POLL_INTERVAL_MINUTES) * 60 * 1000;
console.log(`Her ${POLL_INTERVAL_MINUTES} dakikada bir taranacak. Durdurmak için Ctrl+C.`);

runScan();
setInterval(runScan, intervalMs);
