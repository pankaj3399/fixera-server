import { Types } from "mongoose";
import Project from "../../models/project";

/**
 * Public project search returns cards, not project documents. The card contract is
 * the `project` prop of the frontend's components/search/ProjectCard.tsx (the only
 * consumer of `GET /api/search?type=projects`); detail-page data (FAQ, options,
 * terms, questions, materials, the video) is served by `GET /api/public/projects/:id`.
 */

/**
 * Candidate loads skip `media`: filters, facets, ranking and scheduling never read it,
 * and stored images can be large inline data URLs. Only the returned page is hydrated
 * (see withCardImages).
 */
export const CANDIDATE_PROJECTION = { media: 0 } as const;

type Obj = Record<string, any>;

/** Attach `media.images` (the card carousel) to the page of results, in one read. */
export const withCardImages = async <T extends Obj>(projects: T[]): Promise<T[]> => {
  if (projects.length === 0) return projects;
  const rows = await Project.find({ _id: { $in: projects.map((project) => project._id) } })
    .select("media.images")
    .lean();
  const imagesById = new Map(
    rows.map((row: any) => [String(row._id), Array.isArray(row.media?.images) ? row.media.images : []]),
  );
  return projects.map((project) => ({
    ...project,
    media: { images: imagesById.get(String(project._id)) ?? [] },
  }));
};

const pick = (source: Obj | null | undefined, keys: readonly string[]): Obj | undefined => {
  if (!source || typeof source !== "object") return undefined;
  const out: Obj = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
};

const PROJECT_CARD_FIELDS = [
  "_id",
  "title",
  "description",
  "category",
  "service",
  "areaOfWork",
  "services",
  "timeMode",
  "executionDuration",
  "bufferDuration",
  "pricing",
  "priceModel",
  "projectAvgRating",
  "projectTotalReviews",
  "firstAvailableDate",
  "firstAvailableWindow",
  "shortestThroughputWindow",
] as const;

const PACKAGE_CARD_FIELDS = [
  "name",
  "description",
  "pricing",
  "executionDuration",
  "warrantyPeriod",
  "projectType",
  "included",
  "firstAvailableDate",
  "firstAvailableWindow",
  "shortestThroughputWindow",
] as const;

/** Public professional summary on a card (PublicProfessionalDto: never email or phone). */
const PROFESSIONAL_CARD_FIELDS = [
  "_id",
  "name",
  "username",
  "businessInfo",
  "hourlyRate",
  "currency",
  "profileImage",
  "professionalLevel",
  "adminTags",
  "createdAt",
] as const;

/** One search result trimmed to what the project card reads. */
export const toSearchProjectCard = (project: Obj): Obj => {
  const card = pick(project, PROJECT_CARD_FIELDS) ?? {};
  card.media = { images: Array.isArray(project.media?.images) ? project.media.images : [] };
  if (Array.isArray(project.certifications)) {
    card.certifications = project.certifications.map((certification: Obj) => pick(certification, ["name", "fileUrl"]));
  }
  if (Array.isArray(project.subprojects)) {
    card.subprojects = project.subprojects.map((subproject: Obj) => pick(subproject, PACKAGE_CARD_FIELDS));
  }
  const professional = project.professionalId;
  // A bare id stays as is (the owner could not be loaded); a summary is trimmed.
  card.professionalId =
    professional && typeof professional === "object" && !(professional instanceof Types.ObjectId)
      ? pick(professional, PROFESSIONAL_CARD_FIELDS)
      : professional;
  return card;
};
