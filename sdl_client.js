var SDL = require('sdl');
var VNCClient = require('./vnc-client').VNCClient;

if (process.argv.length < 3) {
    console.error("Usage:" + process.argv[0] + " " + process.argv[1] + " <host> [display#] [password]");
    process.exit(1);
}


SDL.init(SDL.INIT.VIDEO);

const TILE_SIZE = 128;

var rfb = new VNCClient(process.argv[2], parseInt(process.argv[3] || "0", 10), process.argv[4]);
rfb.on('init', function(params) {
    console.log('init', params);
    var w = params.width, h = params.height;
    var screen = SDL.setVideoMode(w, h, 32, SDL.SURFACE.SWSURFACE);
    var xOffset = 0, yOffset = 0;


    rfb.on('rect', function(rect) {
	console.log("rect", rect.x, rect.y, rect.w, rect.h);
	for(var y1 = 0; y1 < rect.h; y1++) {
	    var line = rect.pixels[y1];
	    var y2 = rect.y + y1;
	    for(var x1 = 0; x1 < rect.w; x1++) {
		var rgb = line[x1];
		var color = 0xFF << 24 |
		    rgb[0] << 16 |
		    rgb[1] << 8 |
		    rgb[2];
		var x2 = rect.x + x1;
		SDL.fillRect(screen, [x2, y2, 1, 1], color);
	    }
	}
	SDL.flip(screen);
    });


    var canRequest = true;
    rfb.on('drain', function() {
	canRequest = true;
    });
    function poll() {
	if (!canRequest)
	    return;

	console.log("requestUpdate", xOffset, yOffset, TILE_SIZE, TILE_SIZE, "w", w, "h", h);
	canRequest =
	    rfb.requestUpdate(xOffset, yOffset,
		Math.min(w - xOffset, TILE_SIZE), Math.min(h - yOffset, TILE_SIZE));

	xOffset += TILE_SIZE;
	if (xOffset >= w) {
	    xOffset = 0;
	    yOffset += TILE_SIZE;
	    if (yOffset >= h) {
		yOffset = 0;
	    }
	}
    }
    setInterval(poll, 10);
});
