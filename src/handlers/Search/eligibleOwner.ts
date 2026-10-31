import type { PipelineStage } from "mongoose";

/**
 * Project-owner eligibility, applied inside the aggregation instead of loading
 * every eligible professional id into the application.
 *
 * A project is publicly visible only while its owner still is an approved,
 * non-deleted and non-anonymized professional. Earlier code fetched those ids
 * with `User.distinct` on every search and passed them through a large `$in`;
 * the lookup below is evaluated per candidate project, after the selective
 * project match, so the cost scales with matches rather than with the whole
 * professional collection.
 */
export const eligibleProjectOwnerMatch = {
  role: "professional",
  professionalStatus: "approved",
  deletedAt: null,
  isAnonymized: { $ne: true },
};

export const eligibleProjectOwnerStages = (): PipelineStage[] => [
  {
    $lookup: {
      from: "users",
      // `let` + `$expr` instead of localField/foreignField: the combined form
      // is only supported from MongoDB 5.0, and the codebase still has
      // pre-5.0 fallbacks elsewhere.
      let: { ownerId: "$professionalId" },
      as: "eligibleOwner",
      pipeline: [
        { $match: { $expr: { $eq: ["$_id", "$$ownerId"] } } },
        { $match: { ...eligibleProjectOwnerMatch } },
        { $project: { _id: 1 } },
      ],
    },
  },
  { $match: { "eligibleOwner.0": { $exists: true } } },
  { $project: { eligibleOwner: 0 } },
];
