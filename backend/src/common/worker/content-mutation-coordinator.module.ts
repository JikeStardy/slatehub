import { Global, Module } from '@nestjs/common';
import { ContentMutationCoordinator } from './content-mutation-coordinator';

@Global()
@Module({
  providers: [ContentMutationCoordinator],
  exports: [ContentMutationCoordinator],
})
export class ContentMutationCoordinatorModule {}
