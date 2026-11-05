import { router } from '@kit.ArkUI';

const LIST_PAGE = 'pages/List';

/* FIXME: the header is a mock-up */
@Entry
@Component
struct Home {
  private pathStack: NavPathStack = new NavPathStack();

  goList(): void {
    const options: router.RouterOptions = {
      url: 'pages/List',
      params: { from: 'method' }
    };
    router.pushUrl(options);
  }

  goCart(): void {
    const info = new NavPathInfo('Cart', null);
    this.pathStack.pushPath(info);
  }

  build() {
    Navigation(this.pathStack) {
      Column() {
        Text('Home')
        Button('List').onClick(() => {
          router.pushUrl({ url: LIST_PAGE, params: { from: 'home' } }, router.RouterMode.Single);
        })
        Button('Named').onClick(() => router.pushNamedRoute({ name: 'shared/Named' }))
        Button('Cart').onClick(() => this.pathStack.pushDestinationByName('Cart', null))
        Button('Stub').onClick(() => router.replaceUrl({ url: 'pages/Stub' }))
      }
    }
    .navDestination(PageMap)
  }
}

@Builder
function PageMap(name: string) {
  if (name == 'Cart') {
    CartPage()
  } else if (name === CHECKOUT || name === 'Pay') {
    NavDestination() {
      Text('Pay now')
    }
  } else {
    Text('unknown')
  }
}

const CHECKOUT = 'Checkout';

@Component
struct CartPage {
  @State items: number[] = [1, 2, 3];

  build() {
    NavDestination() {
      List() {
        LazyForEach(this.items, (n: number) => {
          ListItem() {
            Row() {
              Text(`${n}`)
              Image($r('app.media.icon'))
            }
          }
        }, (n: number) => n.toString())
      }
      Repeat<number>(this.items)
        .each((ri: RepeatItem<number>) => {
          Text(ri.item.toString())
        })
        .key((n: number) => n.toString())
    }
  }
}
