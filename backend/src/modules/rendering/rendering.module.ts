import { Module } from '@nestjs/common';
import { VariantRenderService } from './variant-render.service';

@Module({
  providers: [VariantRenderService],
  exports: [VariantRenderService],
})
export class RenderingModule {}
