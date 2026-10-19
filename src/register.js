// Lets Node run the .jsx sources directly, so there is no build step.
import { register } from 'node:module';

register('./jsx-hooks.js', import.meta.url);
