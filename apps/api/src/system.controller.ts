import { Controller, Post } from '@nestjs/common';
import { NativeDirectoryPickerService } from './native-directory-picker.service.js';

@Controller('api/system')
export class SystemController {
  constructor(private readonly directories: NativeDirectoryPickerService) {}
  @Post('select-directory') selectDirectory() { return this.directories.pickDirectory(); }
}
