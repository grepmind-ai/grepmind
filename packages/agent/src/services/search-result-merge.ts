import type { SearchResultItem } from '../backend/contracts/index.js';

const MERGED_BOOST = 0.12;
const NEARBY_BOOST = 0.06;
const SAME_FILE_EVIDENCE_BOOST = 0.03;
const NEARBY_BASE_DISTANCE = 3;
const SEMANTIC_HIGH_SCORE = 0.75;
const MAX_MERGED_PREVIEW_CHARS = 4_000;

type RankedSearchResultItem = SearchResultItem & {
  readonly __rankBucket?: number;
};

interface RgEvidenceAttachment {
  boost: number;
  rgItems: SearchResultItem[];
}

interface SemanticEvidenceMatch {
  boost: number;
  distance: number;
  index: number;
  priority: number;
}

export function mergeSearchResults(input: {
  semanticItems: SearchResultItem[];
  rgItems: SearchResultItem[];
  limit: number;
  contextLines: number;
}): SearchResultItem[] {
  if (input.rgItems.length === 0) {
    return input.semanticItems.slice(0, input.limit);
  }
  if (input.semanticItems.length === 0) {
    return [];
  }

  const mergedSemanticItems: RankedSearchResultItem[] = input.semanticItems.map(
    (item) => ({ ...item }),
  );
  const attachments = collectRgEvidenceAttachments({
    contextLines: input.contextLines,
    rgItems: input.rgItems,
    semanticItems: mergedSemanticItems,
  });
  for (const [index, attachment] of attachments.entries()) {
    const semanticItem = mergedSemanticItems[index];
    if (!semanticItem) {
      continue;
    }

    mergedSemanticItems[index] = mergeIntoSemanticItem({
      boost: attachment.boost,
      rankBucket: 0,
      rgItems: attachment.rgItems,
      semanticItem,
    });
  }

  const rankedSemanticItems = mergedSemanticItems.map((item) =>
    rankItem(item, item.__rankBucket),
  );
  const deduped = dedupeExactItems(rankedSemanticItems);
  return sortRankedItems(deduped).slice(0, input.limit);
}

function collectRgEvidenceAttachments(input: {
  contextLines: number;
  rgItems: SearchResultItem[];
  semanticItems: SearchResultItem[];
}): Map<number, RgEvidenceAttachment> {
  const attachments = new Map<number, RgEvidenceAttachment>();
  for (const rgItem of dedupeExactItems(input.rgItems)) {
    const match = findBestSemanticEvidenceMatch({
      contextLines: input.contextLines,
      rgItem,
      semanticItems: input.semanticItems,
    });
    if (!match) {
      continue;
    }

    const attachment = attachments.get(match.index) ?? {
      boost: 0,
      rgItems: [],
    };
    attachment.boost = Math.max(attachment.boost, match.boost);
    attachment.rgItems.push(rgItem);
    attachments.set(match.index, attachment);
  }

  return attachments;
}

function findBestSemanticEvidenceMatch(input: {
  contextLines: number;
  rgItem: SearchResultItem;
  semanticItems: SearchResultItem[];
}): SemanticEvidenceMatch | null {
  let bestMatch: SemanticEvidenceMatch | null = null;
  for (const [index, semanticItem] of input.semanticItems.entries()) {
    const match = createSemanticEvidenceMatch({
      contextLines: input.contextLines,
      index,
      rgItem: input.rgItem,
      semanticItem,
    });
    if (!match) {
      continue;
    }
    if (!bestMatch || compareEvidenceMatch(match, bestMatch) < 0) {
      bestMatch = match;
    }
  }

  return bestMatch;
}

function createSemanticEvidenceMatch(input: {
  contextLines: number;
  index: number;
  rgItem: SearchResultItem;
  semanticItem: SearchResultItem;
}): SemanticEvidenceMatch | null {
  if (input.rgItem.relativePath !== input.semanticItem.relativePath) {
    return null;
  }

  if (isRgItemInsideSemanticItem(input.rgItem, input.semanticItem)) {
    return {
      boost: MERGED_BOOST,
      distance: 0,
      index: input.index,
      priority: 0,
    };
  }

  const distance = distanceFromSemanticItem(input.rgItem, input.semanticItem);
  if (distance <= input.contextLines + NEARBY_BASE_DISTANCE) {
    return {
      boost: NEARBY_BOOST,
      distance,
      index: input.index,
      priority: 1,
    };
  }

  return {
    boost: SAME_FILE_EVIDENCE_BOOST,
    distance,
    index: input.index,
    priority: 2,
  };
}

function compareEvidenceMatch(
  left: SemanticEvidenceMatch,
  right: SemanticEvidenceMatch,
): number {
  const priorityDelta = left.priority - right.priority;
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  const distanceDelta = left.distance - right.distance;
  if (distanceDelta !== 0) {
    return distanceDelta;
  }

  return left.index - right.index;
}

function mergeIntoSemanticItem(input: {
  boost: number;
  rankBucket: number;
  rgItems: SearchResultItem[];
  semanticItem: SearchResultItem;
}): RankedSearchResultItem {
  return {
    ...input.semanticItem,
    __rankBucket: input.rankBucket,
    previewText: appendRgContext(input.semanticItem.previewText, input.rgItems),
    score: Math.min(1, input.semanticItem.score + input.boost),
  };
}

function dedupeExactItems<T extends SearchResultItem>(items: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const item of items) {
    const key = createExactKey(item);
    const previous = byKey.get(key);
    if (
      !previous ||
      rankBucket(item) < rankBucket(previous) ||
      (rankBucket(item) === rankBucket(previous) && item.score > previous.score)
    ) {
      byKey.set(key, item);
    }
  }

  return [...byKey.values()];
}

function isRgItemInsideSemanticItem(
  rgItem: SearchResultItem,
  semanticItem: SearchResultItem,
): boolean {
  if (rgItem.relativePath !== semanticItem.relativePath) {
    return false;
  }

  return (
    rgItem.symbol.startLine >= semanticItem.symbol.startLine &&
    rgItem.symbol.startLine <= semanticItem.symbol.endLine
  );
}

function distanceFromSemanticItem(
  rgItem: SearchResultItem,
  semanticItem: SearchResultItem,
): number {
  if (rgItem.symbol.startLine < semanticItem.symbol.startLine) {
    return semanticItem.symbol.startLine - rgItem.symbol.startLine;
  }

  return rgItem.symbol.startLine - semanticItem.symbol.endLine;
}

function createExactKey(item: SearchResultItem): string {
  return [item.relativePath, item.symbol.startLine, item.symbol.endLine].join(
    ':',
  );
}

function appendRgContext(
  previewText: string,
  rgItems: SearchResultItem[],
): string {
  const snippets = rgItems
    .map((item) => item.previewText.trim())
    .filter((snippet) => snippet.length > 0 && !previewText.includes(snippet));
  if (snippets.length === 0) {
    return previewText;
  }

  return truncatePreview(
    `${previewText.trim()}\n\nExact match context:\n${snippets.join('\n---\n')}`,
  );
}

function truncatePreview(value: string): string {
  return value.length > MAX_MERGED_PREVIEW_CHARS
    ? `${value.slice(0, MAX_MERGED_PREVIEW_CHARS - 3)}...`
    : value;
}

function rankItem(
  item: RankedSearchResultItem,
  preferredBucket?: number,
): RankedSearchResultItem {
  return {
    ...item,
    __rankBucket: preferredBucket ?? inferRankBucket(item),
  };
}

function inferRankBucket(item: SearchResultItem): number {
  return item.score >= SEMANTIC_HIGH_SCORE ? 2 : 4;
}

function rankBucket(item: SearchResultItem): number {
  return (item as RankedSearchResultItem).__rankBucket ?? inferRankBucket(item);
}

function sortRankedItems(items: RankedSearchResultItem[]): SearchResultItem[] {
  return [...items]
    .sort((left, right) => {
      const bucketDelta = rankBucket(left) - rankBucket(right);
      if (bucketDelta !== 0) {
        return bucketDelta;
      }

      return right.score - left.score;
    })
    .map(stripRankBucket);
}

function stripRankBucket(item: RankedSearchResultItem): SearchResultItem {
  const { __rankBucket: _rankBucket, ...rest } = item;
  return rest;
}
