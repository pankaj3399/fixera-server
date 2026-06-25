import mongoose from 'mongoose';
import BacklinkConfig from '../../models/backlinkConfig';
import BacklinkSubmission from '../../models/backlinkSubmission';
import { scrapePageForLinks, FirecrawlError } from '../firecrawlClient';
import { extractFixeraLinks } from './verification';
import { getEffectiveAllowedDomains } from './domains';
import { rejectSubmission, verifyAndReward } from './rewards';

const LOG_PREFIX = '[backlink]';

/**
 * Crawl the submitted URL via Firecrawl, check for a Fixera link, and
 * transition the submission to verified (+ award points) or rejected.
 */
export async function verifyBacklinkSubmission(
  submissionId: mongoose.Types.ObjectId,
): Promise<void> {
  const submission = await BacklinkSubmission.findOneAndUpdate(
    { _id: submissionId, status: 'pending_verification' },
    { $set: { status: 'verifying' } },
    { new: true },
  );

  if (!submission) {
    console.log(
      `${LOG_PREFIX} Skipping ${submissionId} — not in pending_verification state`,
    );
    return;
  }

  const config = await BacklinkConfig.getCurrentConfig();

  if (!config.isEnabled) {
    await rejectSubmission(submission, 'Program disabled', config);
    return;
  }

  const allowedDomains = getEffectiveAllowedDomains(config);

  let scrapeResult;
  try {
    scrapeResult = await scrapePageForLinks(
      submission.submittedUrl,
      config.crawlTimeoutMs,
    );
  } catch (err) {
    const reason =
      err instanceof FirecrawlError
        ? `Crawl failed: ${err.message}`
        : 'Crawl failed: unexpected error';

    await rejectSubmission(submission, reason, config);
    return;
  }

  const foundLinks = extractFixeraLinks(
    scrapeResult,
    allowedDomains,
    config.requireFollowLink,
  );

  if (foundLinks.length === 0) {
    await rejectSubmission(
      submission,
      `No link to ${allowedDomains.join(' or ')} was found on the page`,
      config,
    );
    return;
  }

  await verifyAndReward(submission, foundLinks, scrapeResult, config);
}

export function scheduleVerification(
  submissionId: mongoose.Types.ObjectId,
): void {
  void verifyBacklinkSubmission(submissionId).catch((err) => {
    console.error(
      `${LOG_PREFIX} Unhandled error in verifyBacklinkSubmission for ${submissionId}:`,
      err,
    );
  });
}
