import type { ChatCompletionMessage } from 'openai/resources/chat/completions';

/**
 * Represents a processed chat message with inline citations and a formatted list of sources.
 */
export interface ProcessedMessage {
  processedContent: string;
  citationsList: string;
}

/**
 * Processes a chat message from the OpenAI API, adding inline citations
 * and generating a formatted list of citation sources from the annotations.
 *
 * @param message - The ChatCompletionMessage object from the OpenAI API response.
 * @returns A ProcessedMessage object containing the updated content and citation list, or null if no processing was needed.
 */
export function processCitations(message: ChatCompletionMessage): ProcessedMessage | null {
  const { content, annotations } = message;

  if (!content || !annotations || annotations.length === 0) {
    return null;
  }

  const urlCitations = annotations
    .map((anno, index) => ({ ...anno, originalIndex: index }))
    .filter((anno) => anno.type === 'url_citation');

  if (urlCitations.length === 0) {
    return null;
  }

  // Create a unique list of citations to generate the numbered list
  const citationSources: { title: string; url: string }[] = [];
  const citationMap = new Map<string, number>();

  for (const anno of urlCitations) {
    if (anno.type === 'url_citation') {
      const { url, title } = anno.url_citation;
      if (!citationMap.has(url)) {
        citationSources.push({ title, url });
        citationMap.set(url, citationSources.length);
      }
    }
  }

  // Build the formatted citation list (e.g., "Citations:\n[1] Title - URL")
  const citationsList = `\n\nCitations:\n${citationSources
    .map((source, i) => `[${i + 1}] ${source.title} - ${source.url}`)
    .join('\n')}`;

  // Insert inline citation markers into the content string.
  // We must process the annotations sorted by end_index in reverse order
  // to avoid messing up the indices of subsequent insertions.
  let processedContent = content;
  const sortedAnnotations = urlCitations.sort((a, b) => {
    if (a.type !== 'url_citation' || b.type !== 'url_citation') return 0;
    return b.url_citation.end_index - a.url_citation.end_index;
  });

  for (const anno of sortedAnnotations) {
    if (anno.type === 'url_citation') {
      const { end_index, url } = anno.url_citation;
      const citationNumber = citationMap.get(url);
      if (citationNumber) {
        const marker = ` [${citationNumber}]`;
        processedContent =
          processedContent.slice(0, end_index) +
          marker +
          processedContent.slice(end_index);
      }
    }
  }

  return { processedContent, citationsList };
}
