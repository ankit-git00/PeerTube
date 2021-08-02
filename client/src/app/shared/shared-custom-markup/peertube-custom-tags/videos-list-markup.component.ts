import { finalize } from 'rxjs/operators'
import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core'
import { AuthService, Notifier } from '@app/core'
import { VideoFilter, VideoSortField } from '@shared/models'
import { Video, VideoService } from '../../shared-main'
import { MiniatureDisplayOptions } from '../../shared-video-miniature'
import { CustomMarkupComponent } from './shared'

/*
 * Markup component list videos depending on criterias
*/

@Component({
  selector: 'my-videos-list-markup',
  templateUrl: 'videos-list-markup.component.html',
  styleUrls: [ 'videos-list-markup.component.scss' ]
})
export class VideosListMarkupComponent implements CustomMarkupComponent, OnInit {
  @Input() sort: string
  @Input() categoryOneOf: number[]
  @Input() languageOneOf: string[]
  @Input() count: number
  @Input() onlyDisplayTitle: boolean
  @Input() filter: VideoFilter
  @Input() isLive: boolean
  @Input() maxRows: number
  @Input() channelHandle: string
  @Input() accountHandle: string

  @Output() loaded = new EventEmitter<boolean>()

  videos: Video[]

  displayOptions: MiniatureDisplayOptions = {
    date: false,
    views: true,
    by: true,
    avatar: false,
    privacyLabel: false,
    privacyText: false,
    state: false,
    blacklistInfo: false
  }

  constructor (
    private auth: AuthService,
    private videoService: VideoService,
    private notifier: Notifier
  ) { }

  getUser () {
    return this.auth.getUser()
  }

  limitRowsStyle () {
    if (this.maxRows <= 0) return {}

    return {
      'grid-template-rows': `repeat(${this.maxRows}, 1fr)`,
      'grid-auto-rows': '0', // Set height to 0 for autogenerated grid rows
      'overflow-y': 'hidden' // Hide grid items that overflow
    }
  }

  ngOnInit () {
    if (this.onlyDisplayTitle) {
      for (const key of Object.keys(this.displayOptions)) {
        this.displayOptions[key] = false
      }
    }

    return this.getVideosObservable()
      .pipe(finalize(() => this.loaded.emit(true)))
      .subscribe(
        ({ data }) => this.videos = data,

        err => this.notifier.error($localize`Error in videos list component: ${err.message}`)
      )
  }

  getVideosObservable () {
    const options = {
      videoPagination: {
        currentPage: 1,
        itemsPerPage: this.count
      },
      categoryOneOf: this.categoryOneOf,
      languageOneOf: this.languageOneOf,
      filter: this.filter,
      isLive: this.isLive,
      sort: this.sort as VideoSortField,
      account: { nameWithHost: this.accountHandle },
      videoChannel: { nameWithHost: this.channelHandle }
    }

    if (this.channelHandle) return this.videoService.getVideoChannelVideos(options)
    if (this.accountHandle) return this.videoService.getAccountVideos(options)

    return this.videoService.getVideos(options)
  }
}
