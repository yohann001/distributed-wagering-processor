import { Global, Module } from '@nestjs/common';

import { Clock } from '../../shared/application/clock';
import { IdGenerator } from '../../shared/application/id-generator';
import { SystemClock } from './system-clock';
import { UuidV7IdGenerator } from './uuidv7-id-generator';

@Global()
@Module({
  providers: [
    { provide: Clock, useClass: SystemClock },
    { provide: IdGenerator, useClass: UuidV7IdGenerator },
  ],
  exports: [Clock, IdGenerator],
})
export class RuntimeModule {}
