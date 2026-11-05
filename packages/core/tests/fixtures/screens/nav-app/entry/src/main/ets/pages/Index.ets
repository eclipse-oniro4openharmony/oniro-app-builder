import { router } from '@kit.ArkUI';
import { RouteNames, ABOUT_URL } from '../common/Routes';
import { Header, Badge } from '../components/Header';
import { DetailPage } from './Detail';
import { ProfilePage } from './Profile';

@Entry
@ComponentV2
struct Index {
  @Local stack: NavPathStack = new NavPathStack();
  @Local items: string[] = ['a', 'b'];

  @Builder
  routes(name: string, param: Object) {
    if (name === RouteNames.DETAIL) {
      DetailPage({ id: param as string })
    } else if (name === 'Profile') {
      ProfilePage()
    }
  }

  @Builder
  footer() {
    Text('v1.0')
    Image($r('app.media.startIcon'))
  }

  build() {
    Navigation(this.stack) {
      Column({ space: 12 }) {
        Header({ title: 'Home' })
        ForEach(this.items, (item: string) => {
          Text(item)
        }, (item: string) => item)
        Button('Open').onClick(() => this.stack.pushPathByName(RouteNames.DETAIL, 'item-1'))
        Button('Profile').onClick(() => {
          this.stack.pushPath({ name: 'Profile', param: 1 })
        })
        Button('About').onClick(() => router.pushUrl({ url: ABOUT_URL }))
        Button('Settings').onClick(() => this.stack.pushPathByName('Settings', null))
        Badge(3)
        this.footer()
      }
    }
    .title('Home')
    .navDestination(this.routes)
  }
}
