import { getAuthorizedUser, getReviewerDirectory } from "../_lib/auth";

export async function GET() {
  const authorized = await getAuthorizedUser();
  if (!authorized) return Response.json({ error: "请先完成成员注册。" }, { status: 401 });
  const reviewers = await getReviewerDirectory({ ...authorized.user, accountUserId: authorized.accountUserId });
  if (!authorized.ndaCompleted) {
    return Response.json({
      reviewers: reviewers.filter((reviewer) => reviewer.permissions.includes("project_owner")).map(publicReviewer),
      limitedToNdaReview: true,
    });
  }
  return Response.json({ reviewers: reviewers.map(publicReviewer), limitedToNdaReview: false });
}

function publicReviewer(reviewer: Awaited<ReturnType<typeof getReviewerDirectory>>[number]) {
  return { email: reviewer.email, displayName: reviewer.displayName, permissions: reviewer.permissions, isAdmin: reviewer.isAdmin, ndaCompleted: reviewer.ndaCompleted };
}
