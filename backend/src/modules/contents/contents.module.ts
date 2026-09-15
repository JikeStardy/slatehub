import { Module } from '@nestjs/common';
import { GroupsModule } from '../groups/groups.module';
import { ImageRendererModule } from '../image-renderer/image-renderer.module';
import { AudioModule } from '../audio/audio.module';
import { TtsModule } from '../tts/tts.module';
import { DynamicContentModule } from '../dynamic-content/dynamic-content.module';
import { RenderingModule } from '../rendering/rendering.module';
import { ContentMutationCoordinatorModule } from '../../common/worker/content-mutation-coordinator.module';
import { ContentsMutationController } from './contents-mutation.controller';
import { ContentsReadController } from './contents-read.controller';
import { ContentsReadService } from './contents-read.service';
import { ContentsService } from './contents.service';
import { ContentAudioBlobService } from './content-audio-blob.service';
import { ContentReadTargetResolver } from './content-read-target-resolver';
import { DeviceCurrentContentService } from './device-current-content.service';
import { MultipartParser } from './multipart-parser';

@Module({
  imports: [
    GroupsModule,
    ImageRendererModule,
    AudioModule,
    TtsModule,
    DynamicContentModule,
    RenderingModule,
    ContentMutationCoordinatorModule,
  ],
  controllers: [ContentsMutationController, ContentsReadController],
  providers: [
    ContentsService,
    ContentsReadService,
    ContentReadTargetResolver,
    MultipartParser,
    ContentAudioBlobService,
    DeviceCurrentContentService,
  ],
  exports: [
    ContentsService,
    ContentsReadService,
    DeviceCurrentContentService,
    ContentReadTargetResolver,
  ],
})
export class ContentsModule {}
