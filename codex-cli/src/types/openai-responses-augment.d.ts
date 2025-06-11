// TypeScript module augmentation for OpenAI Responses API to allow web_search_preview tools
import "openai";
import type { Tool } from "openai/resources/responses/responses";

declare module "openai/resources/responses/responses" {
  interface WebSearchPreviewTool {
    type: "web_search_preview";
    user_location?: {
      type?: string;
      country?: string;
      city?: string;
      region?: string;
      timezone?: string;
    };
    search_context_size?: "high" | "medium" | "low";
  }

  type Tool = FunctionTool | WebSearchPreviewTool;
}
