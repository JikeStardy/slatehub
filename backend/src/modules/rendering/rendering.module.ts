import { Module } from '@nestjs/common';
import { ContentMutationCoordinatorModule } from '../../common/worker/content-mutation-coordinator.module';
import { VariantRenderService } from './variant-render.service';

@Module({
  imports: [ContentMutationCoordinatorModule],
  providers: [VariantRenderService],
  exports: [VariantRenderService],
})
export class RenderingModule {}
