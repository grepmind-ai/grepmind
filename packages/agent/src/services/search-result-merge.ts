import type { SearchResultItem } from '../backend/contracts/index.js';

const MERGED_BOOST = 0.12;
const NEARBY_BOOST = 0.06;
const NEARBY_BASE_DISTANCE = 3;
const SEMANTIC_HIGH_SCORE = 0.75;
const RG_REGEX_SCORE = 0.88;
const MAX_MERGED_PREVIEW_CHARS = 4_000;

type RankedSearchResultItem = SearchResultItem & {
  readonly __rankBucket?: number;
};

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
    return sortRankedItems(
      dedupeExactItems(input.rgItems).map((item) => rankItem(item)),
    ).slice(0, input.limit);
  }

  const mergedSemanticItems: RankedSearchResultItem[] = input.semanticItems.map(
    (item) => ({ ...item }),
  );
  const consumedRgKeys = new Set<string>();
  for (const [index, semanticItem] of mergedSemanticItems.entries()) {
    const insideRgItems = input.rgItems.filter((rgItem) =>
      isRgItemInsideSemanticItem(rgItem, semanticItem),
    );
    if (insideRgItems.length > 0) {
      mergedSemanticItems[index] = mergeIntoSemanticItem({
        boost: MERGED_BOOST,
        rankBucket: 0,
        rgItems: insideRgItems,
        semanticItem,
      });
      for (const matchingRgItem of insideRgItems) {
        consumedRgKeys.add(createExactKey(matchingRgItem));
      }

      continue;
    }

    const nearbyRgItems = input.rgItems.filter((rgItem) =>
      isRgItemNearSemanticItem(rgItem, semanticItem, input.contextLines),
    );
    if (nearbyRgItems.length > 0) {
      mergedSemanticItems[index] = mergeIntoSemanticItem({
        boost: NEARBY_BOOST,
        rankBucket: 0,
        rgItems: nearbyRgItems,
        semanticItem,
      });
      for (const matchingRgItem of nearbyRgItems) {
        consumedRgKeys.add(createExactKey(matchingRgItem));
      }
    }
  }

  const rgOnlyItems = input.rgItems
    .filter((item) => !consumedRgKeys.has(createExactKey(item)))
    .map((item) => rankItem(item));
  const rankedSemanticItems = mergedSemanticItems.map((item) =>
    rankItem(item, item.__rankBucket),
  );
  const deduped = dedupeExactItems([...rankedSemanticItems, ...rgOnlyItems]);
  return sortRankedItems(deduped).slice(0, input.limit);
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

function isRgItemNearSemanticItem(
  rgItem: SearchResultItem,
  semanticItem: SearchResultItem,
  contextLines: number,
): boolean {
  if (rgItem.relativePath !== semanticItem.relativePath) {
    return false;
  }

  const distance =
    rgItem.symbol.startLine < semanticItem.symbol.startLine
      ? semanticItem.symbol.startLine - rgItem.symbol.startLine
      : rgItem.symbol.startLine - semanticItem.symbol.endLine;
  return distance > 0 && distance <= contextLines + NEARBY_BASE_DISTANCE;
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
  if (isRgItem(item)) {
    return item.score <= RG_REGEX_SCORE ? 3 : 1;
  }

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

function isRgItem(item: SearchResultItem): boolean {
  return item.chunkId.startsWith('rg:') || item.symbol.id.startsWith('rg:');
}
