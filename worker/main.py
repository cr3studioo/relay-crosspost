import argparse
import json
import time
from tempfile import TemporaryDirectory
from .core import RelayError
from .source import Source


def main():
    parser = argparse.ArgumentParser(description="Relay: free TikTok crossposting worker")
    parser.add_argument("mode", choices=("tick", "probe", "verify", "local"))
    parser.add_argument("--profile")
    parser.add_argument("--video-url")
    parser.add_argument("--video-id")
    args = parser.parse_args()
    try:
        if args.mode == "probe":
            if not args.profile:
                parser.error("probe requires --profile")
            source = Source()
            posts = list(source.list(args.profile))
            report = {"history_count": len(posts), "history_listing": "passed"}
            selected = next((p for p in posts if p["source_url"] == args.video_url), None) if args.video_url else next((p for p in reversed(posts) if p.get("duration")), None)
            if selected:
                with TemporaryDirectory(prefix="relay-probe-") as folder:
                    _, properties = source.download(selected, folder)
                    report.update(watermark_free_retrieval="passed", media=properties)
            else:
                raise RelayError("no_probe_video_found", permanent=True)
            print(json.dumps(report))
            return
        from .store import Store
        from .providers import Instagram, YouTube
        from .engine import Engine
        if args.mode == "verify" and not args.video_id:
            parser.error("verify requires --video-id; this publishes ONE chosen setup-test video")
        while True:
            store = Store()
            engine = Engine(store, Source(), {"instagram": Instagram(store), "youtube": YouTube(store)})
            print(engine.tick(args.video_id if args.mode == "verify" else None))
            if args.mode != "local":
                break
            time.sleep(900)
    except RelayError as error:
        print("Worker failed: " + error.code)
        raise SystemExit(1) from None
    except (KeyError, ValueError):
        print("Worker configuration is incomplete or invalid. Check required environment variables.")
        raise SystemExit(1) from None
    except Exception:
        # Never dump tracebacks: HTTP exceptions and downloader internals can include tokens.
        print("Worker encountered an unexpected error. Run the test suite and check configuration.")
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
