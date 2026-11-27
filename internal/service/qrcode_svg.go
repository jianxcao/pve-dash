package service

import (
	"fmt"
	"strconv"
	"strings"
)

// Pure-Go ISO/IEC 18004 QR Code (Byte Mode, EC Level L, Versions 1..10) SVG renderer.
// Zero external dependencies and zero outbound network requests.

type qrVersionSpec struct {
	version       int
	totalData     int
	ecPerBlock    int
	numBlocks1    int
	dataPerBlock1 int
	numBlocks2    int
	dataPerBlock2 int
	alignCoords   []int
	versionBits   uint32
}

var qrLevelLSpecs = []qrVersionSpec{
	{1, 19, 7, 1, 19, 0, 0, nil, 0},
	{2, 34, 10, 1, 34, 0, 0, []int{6, 18}, 0},
	{3, 55, 15, 1, 55, 0, 0, []int{6, 22}, 0},
	{4, 80, 20, 1, 80, 0, 0, []int{6, 26}, 0},
	{5, 108, 26, 1, 108, 0, 0, []int{6, 30}, 0},
	{6, 136, 18, 2, 68, 0, 0, []int{6, 34}, 0},
	{7, 156, 20, 2, 78, 0, 0, []int{6, 22, 38}, 0x07C94},
	{8, 194, 24, 2, 97, 0, 0, []int{6, 24, 42}, 0x085BC},
	{9, 232, 30, 2, 116, 0, 0, []int{6, 26, 46}, 0x09A99},
	{10, 274, 18, 2, 68, 2, 69, []int{6, 28, 50}, 0x0A4D3},
}

// GenerateQRSVG encodes payload into a crisp, self-contained SVG QR code (up to 271 UTF-8 bytes).
func GenerateQRSVG(payload string) (string, error) {
	modules, err := encodeQRMatrix([]byte(payload))
	if err != nil {
		return "", err
	}
	size := len(modules)
	const quiet = 4
	viewSize := size + quiet*2

	var pathBuf strings.Builder
	pathBuf.Grow(size * size * 4)
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			if modules[y][x] {
				pathBuf.WriteByte('M')
				pathBuf.WriteString(strconv.Itoa(x + quiet))
				pathBuf.WriteByte(',')
				pathBuf.WriteString(strconv.Itoa(y + quiet))
				pathBuf.WriteString("h1v1h-1z")
			}
		}
	}

	return fmt.Sprintf(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" width="220" height="220" shape-rendering="crispEdges" role="img" aria-label="TOTP QR Code"><rect width="100%%" height="100%%" fill="#ffffff"/><path fill="#000000" d="%s"/></svg>`,
		viewSize, viewSize, pathBuf.String(),
	), nil
}

func encodeQRMatrix(raw []byte) ([][]bool, error) {
	var spec *qrVersionSpec
	for i := range qrLevelLSpecs {
		s := &qrLevelLSpecs[i]
		overheadBytes := 2 // 4-bit mode + 8-bit count + 4-bit terminator = 2 bytes for v1..9
		if s.version >= 10 {
			overheadBytes = 3 // 4-bit mode + 16-bit count + 4-bit terminator
		}
		if len(raw) <= s.totalData-overheadBytes {
			spec = s
			break
		}
	}
	if spec == nil {
		return nil, fmt.Errorf("QR payload too long (%d bytes)", len(raw))
	}

	dataCW := buildQRByteModeData(raw, spec)
	allCW := buildQRCodewordsWithEC(dataCW, spec)

	size := 17 + 4*spec.version
	baseGrid := make([][]bool, size)
	isFunc := make([][]bool, size)
	for i := 0; i < size; i++ {
		baseGrid[i] = make([]bool, size)
		isFunc[i] = make([]bool, size)
	}

	drawQRFunctionPatterns(baseGrid, isFunc, spec)
	placeQRCodewords(baseGrid, isFunc, allCW)

	bestMask := 0
	bestPenalty := int(^uint(0) >> 1)
	var bestGrid [][]bool

	for mask := 0; mask < 8; mask++ {
		cand := cloneBoolGrid(baseGrid)
		applyQRMask(cand, isFunc, mask)
		drawQRFormatBits(cand, isFunc, mask)
		pen := scoreQRPenalty(cand)
		if pen < bestPenalty {
			bestPenalty = pen
			bestMask = mask
			bestGrid = cand
		}
	}
	_ = bestMask
	return bestGrid, nil
}

func buildQRByteModeData(raw []byte, spec *qrVersionSpec) []byte {
	capBits := spec.totalData * 8
	bits := make([]uint8, 0, capBits)
	appendBits := func(val int, n int) {
		for i := n - 1; i >= 0; i-- {
			bits = append(bits, uint8((val>>i)&1))
		}
	}

	appendBits(0b0100, 4) // Byte mode indicator
	if spec.version >= 10 {
		appendBits(len(raw), 16)
	} else {
		appendBits(len(raw), 8)
	}
	for _, b := range raw {
		appendBits(int(b), 8)
	}
	// Up to 4 terminator zero bits
	for i := 0; i < 4 && len(bits) < capBits; i++ {
		bits = append(bits, 0)
	}
	for len(bits)%8 != 0 {
		bits = append(bits, 0)
	}

	out := make([]byte, 0, spec.totalData)
	for i := 0; i < len(bits); i += 8 {
		var b byte
		for j := 0; j < 8; j++ {
			b = (b << 1) | bits[i+j]
		}
		out = append(out, b)
	}
	padBytes := [2]byte{0xEC, 0x11}
	for idx := 0; len(out) < spec.totalData; idx++ {
		out = append(out, padBytes[idx%2])
	}
	return out
}

func gf256Mul(x, y byte) byte {
	var z byte
	for i := 7; i >= 0; i-- {
		z = (z << 1) ^ ((z >> 7) * 0x1D)
		z ^= ((y >> i) & 1) * x
	}
	return z
}

func rsGeneratorPoly(degree int) []byte {
	gen := make([]byte, degree)
	gen[degree-1] = 1
	root := byte(1)
	for i := 0; i < degree; i++ {
		for j := 0; j < degree; j++ {
			gen[j] = gf256Mul(gen[j], root)
			if j+1 < degree {
				gen[j] ^= gen[j+1]
			}
		}
		root = gf256Mul(root, 0x02)
	}
	return gen
}

func rsComputeRemainder(data, gen []byte) []byte {
	rem := make([]byte, len(gen))
	for _, b := range data {
		factor := b ^ rem[0]
		copy(rem, rem[1:])
		rem[len(rem)-1] = 0
		for j, g := range gen {
			rem[j] ^= gf256Mul(g, factor)
		}
	}
	return rem
}

func buildQRCodewordsWithEC(data []byte, spec *qrVersionSpec) []byte {
	totalBlocks := spec.numBlocks1 + spec.numBlocks2
	dataBlocks := make([][]byte, 0, totalBlocks)
	ecBlocks := make([][]byte, 0, totalBlocks)
	gen := rsGeneratorPoly(spec.ecPerBlock)

	offset := 0
	for i := 0; i < spec.numBlocks1; i++ {
		blk := data[offset : offset+spec.dataPerBlock1]
		offset += spec.dataPerBlock1
		dataBlocks = append(dataBlocks, blk)
		ecBlocks = append(ecBlocks, rsComputeRemainder(blk, gen))
	}
	for i := 0; i < spec.numBlocks2; i++ {
		blk := data[offset : offset+spec.dataPerBlock2]
		offset += spec.dataPerBlock2
		dataBlocks = append(dataBlocks, blk)
		ecBlocks = append(ecBlocks, rsComputeRemainder(blk, gen))
	}

	maxDataLen := spec.dataPerBlock1
	if spec.dataPerBlock2 > maxDataLen {
		maxDataLen = spec.dataPerBlock2
	}

	out := make([]byte, 0, spec.totalData+totalBlocks*spec.ecPerBlock)
	for col := 0; col < maxDataLen; col++ {
		for b := 0; b < totalBlocks; b++ {
			if col < len(dataBlocks[b]) {
				out = append(out, dataBlocks[b][col])
			}
		}
	}
	for col := 0; col < spec.ecPerBlock; col++ {
		for b := 0; b < totalBlocks; b++ {
			out = append(out, ecBlocks[b][col])
		}
	}
	return out
}

func setFuncModule(grid, isFunc [][]bool, x, y int, dark bool) {
	grid[y][x] = dark
	isFunc[y][x] = true
}

func drawQRFunctionPatterns(grid, isFunc [][]bool, spec *qrVersionSpec) {
	size := len(grid)

	// Timing patterns
	for i := 0; i < size; i++ {
		setFuncModule(grid, isFunc, 6, i, i%2 == 0)
		setFuncModule(grid, isFunc, i, 6, i%2 == 0)
	}

	// Three 7x7 finder patterns + 1-module white separator border
	drawFinder := func(cx, cy int) {
		for dy := -4; dy <= 4; dy++ {
			for dx := -4; dx <= 4; dx++ {
				x, y := cx+dx, cy+dy
				if x < 0 || x >= size || y < 0 || y >= size {
					continue
				}
				dist := max(absInt(dx), absInt(dy))
				setFuncModule(grid, isFunc, x, y, dist != 2 && dist != 4)
			}
		}
	}
	drawFinder(3, 3)
	drawFinder(size-4, 3)
	drawFinder(3, size-4)

	// Alignment patterns
	coords := spec.alignCoords
	for i, cy := range coords {
		for j, cx := range coords {
			if (i == 0 && j == 0) || (i == 0 && j == len(coords)-1) || (i == len(coords)-1 && j == 0) {
				continue
			}
			for dy := -2; dy <= 2; dy++ {
				for dx := -2; dx <= 2; dx++ {
					dist := max(absInt(dx), absInt(dy))
					setFuncModule(grid, isFunc, cx+dx, cy+dy, dist != 1)
				}
			}
		}
	}

	// Reserve format info slots (written per mask candidate) + fixed dark module
	drawQRFormatBits(grid, isFunc, 0)

	// Version info blocks (v7+)
	if spec.version >= 7 {
		bits := spec.versionBits
		for i := 0; i < 18; i++ {
			dark := ((bits >> i) & 1) != 0
			a := size - 11 + (i % 3)
			b := i / 3
			setFuncModule(grid, isFunc, a, b, dark)
			setFuncModule(grid, isFunc, b, a, dark)
		}
	}
}

func drawQRFormatBits(grid, isFunc [][]bool, mask int) {
	size := len(grid)
	// EC Level L format indicator = 0b01
	data := (0b01 << 3) | (mask & 0x07)
	rem := data
	for i := 0; i < 10; i++ {
		rem = (rem << 1) ^ ((rem >> 9) * 0x537)
	}
	bits := ((data << 10) | rem) ^ 0x5412

	for i := 0; i <= 5; i++ {
		setFuncModule(grid, isFunc, 8, i, ((bits>>i)&1) != 0)
	}
	setFuncModule(grid, isFunc, 8, 7, ((bits>>6)&1) != 0)
	setFuncModule(grid, isFunc, 8, 8, ((bits>>7)&1) != 0)
	setFuncModule(grid, isFunc, 7, 8, ((bits>>8)&1) != 0)
	for i := 9; i < 15; i++ {
		setFuncModule(grid, isFunc, 14-i, 8, ((bits>>i)&1) != 0)
	}

	for i := 0; i < 8; i++ {
		setFuncModule(grid, isFunc, size-1-i, 8, ((bits>>i)&1) != 0)
	}
	for i := 8; i < 15; i++ {
		setFuncModule(grid, isFunc, 8, size-15+i, ((bits>>i)&1) != 0)
	}
	setFuncModule(grid, isFunc, 8, size-8, true) // Always dark module
}

func placeQRCodewords(grid, isFunc [][]bool, codewords []byte) {
	size := len(grid)
	bitIdx := 0
	totalBits := len(codewords) * 8

	upward := true
	for right := size - 1; right >= 1; right -= 2 {
		if right == 6 {
			right = 5
		}
		for vert := 0; vert < size; vert++ {
			y := vert
			if upward {
				y = size - 1 - vert
			}
			for j := 0; j < 2; j++ {
				x := right - j
				if isFunc[y][x] {
					continue
				}
				dark := false
				if bitIdx < totalBits {
					dark = ((codewords[bitIdx>>3] >> (7 - (bitIdx & 7))) & 1) != 0
					bitIdx++
				}
				grid[y][x] = dark
			}
		}
		upward = !upward
	}
}

func applyQRMask(grid, isFunc [][]bool, mask int) {
	size := len(grid)
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			if isFunc[y][x] {
				continue
			}
			var invert bool
			switch mask {
			case 0:
				invert = (x+y)%2 == 0
			case 1:
				invert = y%2 == 0
			case 2:
				invert = x%3 == 0
			case 3:
				invert = (x+y)%3 == 0
			case 4:
				invert = (y/2+x/3)%2 == 0
			case 5:
				invert = (x*y)%2+(x*y)%3 == 0
			case 6:
				invert = ((x*y)%2+(x*y)%3)%2 == 0
			case 7:
				invert = ((x+y)%2+(x*y)%3)%2 == 0
			}
			if invert {
				grid[y][x] = !grid[y][x]
			}
		}
	}
}

func scoreQRPenalty(grid [][]bool) int {
	size := len(grid)
	penalty := 0

	// N1: runs of >= 5 identical modules in rows and columns
	scoreLine := func(get func(int) bool) {
		runColor := get(0)
		runLen := 1
		for i := 1; i < size; i++ {
			c := get(i)
			if c == runColor {
				runLen++
				if runLen == 5 {
					penalty += 3
				} else if runLen > 5 {
					penalty++
				}
			} else {
				runColor = c
				runLen = 1
			}
		}
	}
	for y := 0; y < size; y++ {
		row := y
		scoreLine(func(x int) bool { return grid[row][x] })
	}
	for x := 0; x < size; x++ {
		col := x
		scoreLine(func(y int) bool { return grid[y][col] })
	}

	// N2: 2x2 blocks of identical color
	for y := 0; y < size-1; y++ {
		for x := 0; x < size-1; x++ {
			c := grid[y][x]
			if grid[y][x+1] == c && grid[y+1][x] == c && grid[y+1][x+1] == c {
				penalty += 3
			}
		}
	}

	// N4: dark/total balance
	darkCount := 0
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			if grid[y][x] {
				darkCount++
			}
		}
	}
	total := size * size
	k := absInt(darkCount*20-total*10) / total
	penalty += k * 10
	return penalty
}

func cloneBoolGrid(src [][]bool) [][]bool {
	dst := make([][]bool, len(src))
	for i := range src {
		dst[i] = make([]bool, len(src[i]))
		copy(dst[i], src[i])
	}
	return dst
}

func absInt(v int) int {
	if v < 0 {
		return -v
	}
	return v
}
