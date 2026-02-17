~~~
Agentic setup is partly there, but the goal is for setup to be implemented as a conversation flow with the agent (unless the user chooses to Just Jump In).
~~~
Text scrolling gets really weird, especially when we reach the end of the viewport. The entire viewport does not scroll together; instead once we reach the end of the viewport, new lines begin to scroll upward and conflict with lines already on the screen.
~~~
The conversation turn background color should fill the entire lines comprising the turn text; the goal is for the text blocks to have rectangular colored backgrounds (helps with legibility).
~~~
Choice modals need to be up/down arrow selections; using A/B/C/D masks over the user's ability to type their own message
~~~
Campaign names need uniqueness-checking, so new campaigns don't save over old ones.
~~~
"overloaded_error" prints to the user's view instead of invoking 429-handling code
~~~
