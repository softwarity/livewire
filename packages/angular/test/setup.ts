// Zoneless, deliberately: this library is written for applications that do not
// ship zone.js, and its one contract with change detection - `markForCheck()`
// in the template - only means anything there.
import { setupZonelessTestEnv } from 'jest-preset-angular/setup-env/zoneless';

setupZonelessTestEnv();
