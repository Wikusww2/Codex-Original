# Simple Web Search UI Test

This application demonstrates how to use the OpenAI API with the web search tool to get responses to queries.

## Setup

1.  **API Key**: Open `script.js` and replace `YOUR_OPENAI_API_KEY` with your actual OpenAI API key.
    ```javascript
    const apiKey = "YOUR_OPENAI_API_KEY";
    ```
    **Important**: For this simple test, the API key is used directly in client-side JavaScript. In a production application, you should never expose your API key this way. It should be handled by a backend server.

2.  **Model**: The application is configured to use `gpt-4.1`. Ensure your API key has access to this model or change it in `script.js` to a model you have access to that supports web search (e.g., `gpt-4-turbo`).

## How to Run

1.  After setting your API key, simply open the `index.html` file in your web browser.
2.  Type your query into the input field and click "Search".
3.  The response from the model, incorporating web search results, will be displayed below.
